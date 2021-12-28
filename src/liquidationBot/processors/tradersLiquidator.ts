import type { Trader } from "@liquidationBot/types";
import type { LiquidationsResults } from "@liquidationBot/services";
import { WritableOptions, Duplex, Readable, Writable } from "node:stream";
import { EventEmitter, once } from "node:events";
import { setTimeout } from "node:timers/promises";
import _ from "lodash";
import { CheckError, LiquidationError } from "@liquidationBot/errors";
import { exchangeService } from "@liquidationBot/services";
import { FilterLiquidatableTraders } from "@liquidationBot/services/liquidationBot";
import { IExchange } from "@generated/IExchange";

export type TradersLiquidatorResult =
  | { liquidatableChecksErrors: CheckError[] }
  | {
      liquidationsResults: LiquidationsResults;
      liquidationsErrors: LiquidationError[];
    };
export type TradersLiquidatorProcessor = Duplex & {
  [Symbol.asyncIterator](): AsyncIterableIterator<TradersLiquidatorResult>;
};

export function start(
  exchange: IExchange,
  liquidatableTradersFilters: FilterLiquidatableTraders[],
  retryIntervalSec: number
): TradersLiquidatorProcessor {
  const liquidatableTraders = new Set<Trader>();
  const tradersEvents = new EventEmitter();

  const saveLiquidatableTraders: WritableOptions["write"] = (
    newLiquidatableTraders: Trader[],
    _: never, // encoding. Irrelevant for streams in object mode
    callback: (error?: Error) => void
  ) => {
    newLiquidatableTraders.forEach((trader) => liquidatableTraders.add(trader));

    if (liquidatableTraders.size) {
      tradersEvents.emit("gotLiquidatableTraders", true);
    }

    callback();
  };

  type LiquidationGenerator = () => AsyncGenerator<TradersLiquidatorResult>;
  const liquidationsGenerator: LiquidationGenerator = async function* () {
    while (true) {
      if (!liquidatableTraders.size) {
        await once(tradersEvents, "gotLiquidatableTraders");
      }
      const { liquidationsResults, liquidationsErrors } =
        await exchangeService.liquidate(exchange, [...liquidatableTraders]);

      const liquidatedTraders = Object.keys(liquidationsResults) as Trader[];
      liquidatedTraders.forEach((trader) => liquidatableTraders.delete(trader));

      yield { liquidationsResults, liquidationsErrors };

      if (liquidationsErrors.length) {
        // some liquidation errors may cost gas so
        // a timeout is added in order to reduce the chance of consequent errors
        await setTimeout(retryIntervalSec);
      }

      /*
       * before trying to liquidate traders again, check which of them are still
       * liquidatable (e.g. we don't want to try to liquidate a trader that has
       * already been liquidated by a competitor bot) and remove from the
       * nonLiquidatableTraders list ones that are not liquidatable anymore
       */
      const erroredTraders = liquidationsErrors.map(({ trader }) => trader);
      const { nonLiquidatableTraders, liquidatableChecksErrors } =
        await filterNonLiquidatableTraders(
          erroredTraders,
          liquidatableTradersFilters
        );
      nonLiquidatableTraders.forEach((nonLiquidatableTrader) => {
        liquidatableTraders.delete(nonLiquidatableTrader);
      });
      if (liquidatableChecksErrors.length) {
        yield { liquidatableChecksErrors };
      }
    }
  };

  async function filterNonLiquidatableTraders(
    traders: Trader[],
    liquidatableTradersFilters: FilterLiquidatableTraders[]
  ) {
    const nonLiquidatableTraders = new Set<Trader>(traders);
    const liquidatableChecksErrors: CheckError[] = [];
    let returnResults: (value?: unknown) => void;
    let throwOnUnexpectedError: (error: Error) => void;
    const someFilterSucceedOrAllFails = new Promise((resolve, reject) => {
      returnResults = resolve;
      throwOnUnexpectedError = reject;
    });
    let processed = 0;

    for (const filter of liquidatableTradersFilters) {
      (async () => {
        let gotSomeNonErrorResults = false;
        for await (const checkResult of filter(traders)) {
          if (checkResult instanceof CheckError) {
            liquidatableChecksErrors.push(checkResult);
          } else {
            gotSomeNonErrorResults = true;
            _(checkResult)
              .pickBy(Boolean)
              .keys()
              .forEach((trader) =>
                nonLiquidatableTraders.delete(trader as Trader)
              );
          }
        }
        return gotSomeNonErrorResults;
      })().then(
        (gotSomeNonErrorResults) => {
          const allProcessed = ++processed == liquidatableTradersFilters.length;
          if (allProcessed || gotSomeNonErrorResults) {
            returnResults();
          }
        },
        (unexpectedError: Error) => throwOnUnexpectedError(unexpectedError)
      );
    }

    await someFilterSucceedOrAllFails;

    return {
      nonLiquidatableTraders,
      liquidatableChecksErrors,
    };
  }

  return Duplex.from({
    writable: new Writable({
      write: saveLiquidatableTraders,
      objectMode: true,
    }),
    readable: Readable.from(liquidationsGenerator()),
  });
}
