import type { LiquidationBotEvents } from "@liquidationBot/reporting";
import { setTimeout } from "node:timers/promises";
import { LiquidationError } from "@liquidationBot/errors";
import { BigNumber } from "ethers";
import { LiquidationBot, liquidationBot } from "@liquidationBot/bot";
import { IExchange } from "@generated/IExchange";
import { LiquidationBotApi } from "@generated/LiquidationBotApi";
import { Provider } from "@ethersproject/providers";
import { IExchangeEvents } from "@generated/IExchangeEvents";

type ChangePositionEventResult = {
  args: {
    trader: string;
    previousAsset: BigNumber;
    previousStable: BigNumber;
    newAsset: BigNumber;
    newStable: BigNumber;
  };
};

jest.disableAutomock();

const setupMocks = (
  liquidationBot: LiquidationBot
): {
  mockChangePositionEvents: jest.MockedFunction<
    () => Promise<ChangePositionEventResult[]>
  >;
  mockLiquidate: jest.MockedFunction<() => Promise<Symbol>>;
  mockSupportIsLiquidatable: jest.Mock[];
  mockIsLiquidatable: jest.Mock;
  start: () => void;
  consts: {
    exchangeLaunchBlock: number;
    maxBlocksPerJsonRpcQuery: number;
    fetcherRetryIntervalSec: number;
    checkerRetryIntervalSec: number;
    liquidatorRetryIntervalSec: number;
    maxTradersPerLiquidationCheck: number;
  };
} => {
  // TODO `as any as Type` conversion is not safe.  It would be nice to replace it with a more
  // comprehensive mock.  One that would through a meaningful error if an unexpected property is
  // accessed, for example.
  const mockLiquidate = jest.fn() as jest.MockedFunction<() => Promise<Symbol>>;
  const mockExchange = {
    liquidate: mockLiquidate,
  } as any as IExchange;

  const mockChangePositionEvents = jest.fn() as jest.MockedFunction<
    () => Promise<ChangePositionEventResult[]>
  >;
  const mockExchangeEvents = {
    queryFilter: () => mockChangePositionEvents(),
    filters: { PositionChanged: () => null },
  } as any as IExchangeEvents;

  const mockIsLiquidatable = jest.fn();
  const mockLiquidationBotApi = {
    callStatic: { isLiquidatable: mockIsLiquidatable },
  } as any as LiquidationBotApi;

  const consts = {
    exchangeLaunchBlock: 0,
    maxBlocksPerJsonRpcQuery: 100,
    fetcherRetryIntervalSec: 0.02,
    checkerRetryIntervalSec: 0.01,
    liquidatorRetryIntervalSec: 0.005,
    maxTradersPerLiquidationCheck: 1000,
  };

  const mockSupportIsLiquidatable: jest.Mock[] = [];

  const mockProvider = {
    getBlockNumber: () => 10,
  } as any as Provider;

  const start = () => {
    // NOTE Timeouts here need to be very low, as we need to wait for a timeout to expire when
    // are stopping our tests.  So the shorter the timeouts are, the less time our tests will waste
    // when stopping.
    liquidationBot.start(
      mockProvider,
      mockExchange,
      mockExchangeEvents,
      mockLiquidationBotApi,
      consts.exchangeLaunchBlock,
      consts.maxBlocksPerJsonRpcQuery,
      consts.fetcherRetryIntervalSec,
      consts.checkerRetryIntervalSec,
      consts.liquidatorRetryIntervalSec,
      consts.maxTradersPerLiquidationCheck,
      {
        supportLiquidationBotApis: mockSupportIsLiquidatable.map(
          (isLiquidatable) =>
            ({
              callStatic: { isLiquidatable },
            } as any as LiquidationBotApi)
        ),
      }
    );
  };

  return {
    mockChangePositionEvents,
    mockLiquidate,
    mockIsLiquidatable,
    start,
    consts,
    mockSupportIsLiquidatable,
  };
};

describe("liquidationBot", () => {
  /*
   * Because bot processors cycles are running on timers, the most natural way
   * to write integration tests on it would be to use Jest's fake timers API.
   * But unfortunately it doesn't work properly with Promises.
   * https://github.com/facebook/jest/issues/7151
   * Workaround exists, and I have tried some of them, but the results was from
   * not working at all to working unreliable.
   * Maybe it can be setup better, but I have decided just to set cycles time
   * length to a very low values in .env.test and control bot execution by
   * listening events. And it works great
   */
  type EventTypes = LiquidationBotEvents["type"];
  let botEvents: LiquidationBotEvents[] = [];

  // call collectBotEvents after bot.start() to collect specified events into
  // botEvents to assert them by the end of the test. If no events to collect
  // are specified then all events would be collected
  const collectBotEvents = (...eventsTypes: EventTypes[]) => {
    (async () => {
      for await (const event of liquidationBot.getEventsIterator()) {
        if (!eventsTypes || eventsTypes.includes(event.type)) {
          botEvents.push(event);
        }
      }
    })();
  };

  type EventsByEventsTypes<EventsTypes extends EventTypes[]> =
    EventsTypes extends [infer EventType, ...infer RestEventsTypes]
      ? RestEventsTypes extends EventTypes[]
        ? [
            LiquidationBotEvents & { type: EventType },
            ...EventsByEventsTypes<RestEventsTypes>
          ]
        : never
      : [];

  // `| [EventTypes]` is a hint to ensure that
  // inferred type of EventsTypes would be tuple and not array.
  // https://github.com/microsoft/TypeScript/issues/27179 - see last comments.
  // Alternative with multiple `readonly` and `as const` in every call is much uglier.
  const onceBotEvents = async <EventsTypes extends EventTypes[] | [EventTypes]>(
    eventsTypes: EventsTypes
  ): Promise<EventsByEventsTypes<EventsTypes>> => {
    const collectedEvents = [];
    for await (const event of liquidationBot.getEventsIterator()) {
      if (event.type === eventsTypes[collectedEvents.length]) {
        collectedEvents.push(event);
        if (collectedEvents.length == eventsTypes.length) {
          break;
        }
      }
    }
    return collectedEvents as EventsByEventsTypes<EventsTypes>;
  };

  afterEach(async () => {
    await liquidationBot.stop();
    botEvents = [];
  });

  it("should liquidate liquidatable trader", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValueOnce([true]);
    const mockLiquidationResult = Symbol("mockLiquidationResult");
    mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

    start();
    const [{ trader }] = await onceBotEvents(["traderLiquidated"]);

    expect(trader).toEqual("trader1");
  });

  it("should not liquidate non-liquidatable trader", async () => {
    const { mockChangePositionEvents, mockIsLiquidatable, start } =
      setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValue([false]);

    start();
    collectBotEvents("traderLiquidated", "error");
    await onceBotEvents(["tradersChecked", "tradersChecked"]);

    expect(botEvents).toBeEmpty();
  });

  it("should not liquidate trader who closed their position", async () => {
    const { mockChangePositionEvents, mockIsLiquidatable, start } =
      setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValue([false]);

    start();
    await onceBotEvents(["tradersChecked", "tradersFetched"]);

    closePositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValue([true]);

    expect(botEvents).toBeEmpty();
  });

  it("should liquidate only liquidatable trader", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1", "trader2"]);
    mockIsLiquidatable.mockResolvedValueOnce([false, true]);
    const mockLiquidationResult = Symbol("mockLiquidationResult");
    mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

    start();
    const [{ trader }] = await onceBotEvents(["traderLiquidated"]);

    expect(trader).toEqual("trader2");
  });

  it("should liquidate trader after it would become liquidatable", async () => {
    const { mockChangePositionEvents, mockIsLiquidatable, start } =
      setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValueOnce([false]);
    mockIsLiquidatable.mockResolvedValueOnce([true]);

    start();
    collectBotEvents("tradersChecked", "traderLiquidated", "error");
    await onceBotEvents(["traderLiquidated"]);

    expect(botEvents).toEqual([
      expect.objectContaining({ type: "tradersChecked" }),
      expect.objectContaining({ type: "tradersChecked" }),
      expect.objectContaining({ type: "traderLiquidated" }),
    ]);
  });

  it("should not liquidate trader after it has been liquidated", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValueOnce([true]);
    mockIsLiquidatable.mockResolvedValue([false]);
    const mockLiquidationResult = Symbol("mockLiquidationResult");
    mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

    start();
    collectBotEvents("tradersChecked", "traderLiquidated", "error");
    await onceBotEvents(["tradersChecked", "tradersChecked", "tradersChecked"]);

    expect(botEvents).toEqual([
      expect.objectContaining({ type: "tradersChecked" }),
      expect.objectContaining({ type: "traderLiquidated" }),
      expect.objectContaining({ type: "tradersChecked" }),
      expect.objectContaining({ type: "tradersChecked" }),
    ]);
  });

  it("should retry to liquidate when error occurs on liquidation", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValueOnce([true]); // call in check processor
    mockIsLiquidatable.mockResolvedValueOnce([true]); // call before retry
    mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));
    const mockLiquidationResult = Symbol("mockLiquidationResult") as any;
    mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

    start();
    collectBotEvents("tradersChecked", "traderLiquidated", "error");
    await onceBotEvents([
      "error", // mock liquidate error
      "traderLiquidated",
    ]);

    expect(botEvents).toEqual([
      expect.objectContaining({ type: "tradersChecked" }),
      { type: "error", error: expect.any(LiquidationError) },
      {
        type: "traderLiquidated",
        trader: "trader1",
        contractTransaction: mockLiquidationResult,
      },
    ]);
  });

  it("should not retry to liquidate when after error liquidatable trader becomes non-liquidatable", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValueOnce([true]); // call in check processor
    mockIsLiquidatable.mockResolvedValue([false]); // call before retry and after
    mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));

    start();
    collectBotEvents("traderLiquidated", "error");
    await onceBotEvents([
      "error", // mock liquidate error
      "tradersChecked",
    ]);

    expect(botEvents).toEqual([
      { type: "error", error: expect.any(LiquidationError) },
    ]);
  });

  // TODO This logic is not implemented yet.
  it.skip("should not retry to liquidate when liquidation failed twice", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
    } = setupMocks(liquidationBot);

    openPositions(mockChangePositionEvents, ["trader1"]);
    mockIsLiquidatable.mockResolvedValue([true]);
    mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error 1"));
    mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error 2"));

    start();
    collectBotEvents("traderLiquidated", "error");
    await onceBotEvents([
      "error", // mock liquidate error 1
      "error", // mock liquidate error 2
      "tradersChecked",
    ]);

    expect(botEvents).toEqual([
      { type: "error", error: expect.any(LiquidationError) },
      { type: "error", error: expect.any(LiquidationError) },
    ]);
  });

  it("should determine liquidatable traders when number of active traders exceeds the chunk size of liquidation bot api", async () => {
    const {
      mockChangePositionEvents,
      mockLiquidate,
      mockIsLiquidatable,
      start,
      consts,
    } = setupMocks(liquidationBot);

    consts.maxTradersPerLiquidationCheck = 100;
    const activeTraders = Array.from({ length: 500 }, (_, i) => `trader${i}`);
    openPositions(mockChangePositionEvents, activeTraders);
    mockIsLiquidatable.mockResolvedValue([false, true]);
    const mockLiquidationResult = Symbol("mockLiquidationResult");
    mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

    start();
    const [
      { trader: trader1 },
      { trader: trader2 },
      { trader: trader3 },
      { trader: trader4 },
      { trader: trader5 },
    ] = await onceBotEvents([
      "traderLiquidated",
      "traderLiquidated",
      "traderLiquidated",
      "traderLiquidated",
      "traderLiquidated",
    ]);

    expect(trader1).toEqual("trader1");
    expect(trader2).toEqual("trader101");
    expect(trader3).toEqual("trader201");
    expect(trader4).toEqual("trader301");
    expect(trader5).toEqual("trader401");
  });

  describe("extensions", () => {
    describe("with support isLiquidatable checkers", () => {
      describe("when support checker is a duplicate of the main one", () => {
        it("should liquidate liquidatable trader", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            mockSupportIsLiquidatable,
            start,
          } = setupMocks(liquidationBot);

          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable.mockResolvedValueOnce([true]);
          mockSupportIsLiquidatable.push(
            jest.fn().mockResolvedValueOnce([true])
          );
          const mockLiquidationResult = Symbol("mockLiquidationResult");
          mockLiquidate.mockResolvedValueOnce(mockLiquidationResult);

          start();
          const [{ trader }] = await onceBotEvents(["traderLiquidated"]);

          expect(trader).toEqual("trader1");
        });
      });

      describe("when support checker working slower than the main one", () => {
        it("shouldn't try to liquidate twice the same trader when response from the slow checker is obtained", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            mockSupportIsLiquidatable,
            start,
          } = setupMocks(liquidationBot);

          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable.mockImplementationOnce(async () => {
            await setTimeout(20);
            return [true];
          });
          mockSupportIsLiquidatable.push(
            jest.fn().mockImplementationOnce(async () => {
              await setTimeout(50);
              return [true];
            })
          );
          const mockLiquidationResult = Symbol("mockLiquidationResult");
          mockLiquidate.mockResolvedValue(mockLiquidationResult);

          start();
          collectBotEvents("traderLiquidated");
          await setTimeout(80);

          expect(botEvents).toHaveLength(1);
        });
      });

      describe("retry on liquidation error", () => {
        it("should emit error when both checkers fell", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            start,
            mockSupportIsLiquidatable,
            consts,
          } = setupMocks(liquidationBot);

          // For a simpler stubbing, ensure that tradersChecker processor
          // wouldn't get called twice during the test
          consts.checkerRetryIntervalSec = 0.5;
          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable
            // call in check processor
            .mockResolvedValueOnce([true])
            // call before retry
            .mockImplementationOnce(async () => {
              await setTimeout(20);
              throw Error("mock primary liquidation checker error");
            });
          mockSupportIsLiquidatable.push(
            jest
              .fn()
              // call in check processor
              .mockResolvedValueOnce([true])
              // call before retry
              .mockImplementationOnce(async () => {
                await setTimeout(50);
                throw Error("mock support liquidation check error");
              })
          );
          mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));

          start();
          collectBotEvents("tradersChecked", "traderLiquidated", "error");
          const [
            { error: liquidationError },
            { error: primaryLiquidationCheckerError },
            { error: supportLiquidationCheckerError },
          ] = await onceBotEvents([
            "error", // mock liquidate error
            "error", // mock primary liquidate checkers errors
            "error", // mock secondary liquidate checkers errors
            "tradersChecked", // means the bot didn't crash or freeze after all errors
          ]);

          // @ts-ignore
          expect(liquidationError.cause.message).toBe("mock liquidate error");
          // @ts-ignore
          expect(primaryLiquidationCheckerError.cause.message).toBe(
            "mock primary liquidation checker error"
          );
          // @ts-ignore
          expect(supportLiquidationCheckerError.cause.message).toBe(
            "mock support liquidation check error"
          );
        });

        it("should use the result of the faster checker when both succeed", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            start,
            mockSupportIsLiquidatable,
            consts,
          } = setupMocks(liquidationBot);

          // For a simpler stubbing, ensure that tradersChecker processor
          // wouldn't get called twice during the test
          consts.checkerRetryIntervalSec = 0.5;
          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable
            // call in check processor
            .mockResolvedValueOnce([true])
            // call before retry
            .mockImplementationOnce(async () => {
              await setTimeout(20);
              return [false];
            });
          mockSupportIsLiquidatable.push(
            jest
              .fn()
              // call in check processor
              .mockResolvedValueOnce([true])
              // call before retry
              .mockImplementationOnce(async () => {
                await setTimeout(50);
                return [true];
              })
          );
          mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));

          start();
          collectBotEvents("tradersChecked", "traderLiquidated", "error");
          const [{ error: liquidationError }] = await onceBotEvents(["error"]);
          await setTimeout(200); // wait for tradersLiquidator cycle to be 100% finished

          expect(botEvents).not.toIncludeAllPartialMembers([
            { type: "traderLiquidated" },
          ]);
        });

        it("should use the result of the slower checker when faster fell", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            start,
            mockSupportIsLiquidatable,
            consts,
          } = setupMocks(liquidationBot);

          // For a simpler stubbing, ensure that tradersChecker processor
          // wouldn't get called twice during the test
          consts.checkerRetryIntervalSec = 0.5;
          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable
            // call in check processor
            .mockResolvedValueOnce([true])
            // call before retry
            .mockImplementationOnce(async () => {
              await setTimeout(20);
              throw Error("mock primary liquidation checker error");
            });
          mockSupportIsLiquidatable.push(
            jest
              .fn()
              // call in check processor
              .mockResolvedValueOnce([true])
              // call before retry
              .mockImplementationOnce(async () => {
                await setTimeout(50);
                return [true];
              })
          );
          mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));

          start();
          collectBotEvents("tradersChecked", "traderLiquidated", "error");
          const [
            { error: liquidationError },
            { error: primaryLiquidationCheckerError },
            { trader: liquidatedTrader },
          ] = await onceBotEvents([
            "error", // mock liquidate error
            "error", // mock primary liquidate checkers errors
            "traderLiquidated", // mock secondary liquidate checkers errors
          ]);

          // @ts-ignore
          expect(liquidationError.cause.message).toBe("mock liquidate error");
          // @ts-ignore
          expect(primaryLiquidationCheckerError.cause.message).toBe(
            "mock primary liquidation checker error"
          );
          expect(liquidatedTrader).toBe("trader1");
        });

        it("should use the result of the faster checker when faster succeed and slower fell", async () => {
          const {
            mockChangePositionEvents,
            mockLiquidate,
            mockIsLiquidatable,
            start,
            mockSupportIsLiquidatable,
            consts,
          } = setupMocks(liquidationBot);

          // For a simpler stubbing, ensure that tradersChecker processor
          // wouldn't get called twice during the test
          consts.checkerRetryIntervalSec = 0.5;
          openPositions(mockChangePositionEvents, ["trader1"]);
          mockIsLiquidatable
            // call in check processor
            .mockResolvedValueOnce([true])
            // call before retry
            .mockImplementationOnce(async () => {
              await setTimeout(20);
              return [true];
            });
          mockSupportIsLiquidatable.push(
            jest
              .fn()
              // call in check processor
              .mockResolvedValueOnce([true])
              // call before retry
              .mockImplementationOnce(async () => {
                await setTimeout(50);
                throw Error("mock secondary liquidation checker error");
              })
          );
          mockLiquidate.mockRejectedValueOnce(Error("mock liquidate error"));

          start();
          collectBotEvents("tradersChecked", "traderLiquidated", "error");
          const [{ error: liquidationError }, { trader: liquidatedTrader }] =
            await onceBotEvents([
              "error", // mock liquidate error"error"
              "traderLiquidated", // mock secondary liquidate checkers errors
            ]);
          await setTimeout(200); // wait for tradersLiquidator cycle to be 100% finished

          // @ts-ignore
          expect(liquidationError.cause.message).toBe("mock liquidate error");
          expect(liquidatedTrader).toBe("trader1");
          expect(botEvents.filter(({ type }) => type == "error")).toHaveLength(
            1
          );
        });
      });
    });
  });
});

function openPositions(
  mockChangePositionEvents: jest.MockedFunction<
    () => Promise<ChangePositionEventResult[]>
  >,
  traders: string[]
) {
  addTradeActivity(
    mockChangePositionEvents,
    traders,
    BigNumber.from(0),
    BigNumber.from(0),
    BigNumber.from(100),
    BigNumber.from(100)
  );
}

function closePositions(
  mockChangePositionEvents: jest.MockedFunction<
    () => Promise<ChangePositionEventResult[]>
  >,
  traders: string[]
) {
  addTradeActivity(
    mockChangePositionEvents,
    traders,
    BigNumber.from(100),
    BigNumber.from(100),
    BigNumber.from(0),
    BigNumber.from(0)
  );
}

function addTradeActivity(
  mockChangePositionEvents: jest.MockedFunction<
    () => Promise<ChangePositionEventResult[]>
  >,
  traders: string[],
  previousAsset: BigNumber,
  previousStable: BigNumber,
  newAsset: BigNumber,
  newStable: BigNumber
) {
  const activities = traders.map((trader) => {
    return {
      args: { previousAsset, previousStable, newAsset, newStable, trader },
    };
  });
  mockChangePositionEvents.mockResolvedValue(activities);
}
