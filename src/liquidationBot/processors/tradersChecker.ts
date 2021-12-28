import type { CheckError } from "@liquidationBot/errors";
import type { WritableOptions } from "node:stream";
import type { Trader } from "@liquidationBot/types";
import { pipeline } from "node:stream/promises";
import { Writable, Duplex, PassThrough } from "node:stream";
import { EventEmitter, once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { FilterLiquidatableTraders } from "@liquidationBot/services/liquidationBot";
import { isEmpty } from "lodash";

export type TradersCheckerProcessor = Duplex & {
  [Symbol.asyncIterator](): AsyncIterableIterator<Trader[] | CheckError>;
};

export function start(
  reCheckIntervalSec: number,
  liquidatableTradersFilters: FilterLiquidatableTraders[]
): TradersCheckerProcessor {
  let traders: { [k in Trader]: number | null } = {};
  const tradersEvents = new EventEmitter();

  const saveActiveTraders: WritableOptions["write"] = (
    activeTraders: Trader[],
    _: never, // encoding. Irrelevant for streams in object mode
    callback: (error?: Error) => void
  ) => {
    traders = Object.fromEntries(
      activeTraders.map((trader) => [trader, traders[trader] ?? null])
    );

    if (!isEmpty(traders)) {
      tradersEvents.emit("gotActiveTraders", true);
    }

    callback();
  };

  const liquidatableTradersGenerators = liquidatableTradersFilters.map(
    (liquidatableTradersFilter) =>
      async function* () {
        while (true) {
          if (isEmpty(traders)) {
            await once(tradersEvents, "gotActiveTraders");
          }
          const activeTraders = Object.keys(traders) as Trader[];
          const checkedAt = Date.now();
          for await (const checkedTraders of liquidatableTradersFilter(
            activeTraders
          )) {
            if (checkedTraders instanceof Error) {
              yield checkedTraders;
            }
            const newLiquidatableTraders: Trader[] = [];
            let hadNewData = false;
            for (const check of Object.entries(checkedTraders)) {
              const [trader, isLiquidatable] = check as [Trader, boolean];
              const traderLastCheckedAt = traders[trader];
              if (traderLastCheckedAt && traderLastCheckedAt >= checkedAt) {
                continue;
              }
              hadNewData = true;
              traders[trader] = checkedAt;
              if (isLiquidatable) {
                newLiquidatableTraders.push(trader);
              }
            }
            if (hadNewData) {
              yield newLiquidatableTraders;
            }
          }
          await setTimeout(reCheckIntervalSec * 1_000);
        }
      }
  );

  const liquidatableTraders = new PassThrough({ objectMode: true });
  for (const liquidatableTradersGenerator of liquidatableTradersGenerators) {
    pipeline(liquidatableTradersGenerator(), liquidatableTraders).catch(
      () => {} // ignore abort signal
    );
  }

  return Duplex.from({
    writable: new Writable({ write: saveActiveTraders, objectMode: true }),
    readable: liquidatableTraders,
  });
}
