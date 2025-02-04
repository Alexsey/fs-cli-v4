import { parseEther } from "@ethersproject/units";
import { IERC20__factory } from "@generated/factories/IERC20__factory";
import * as liquidationBot from "@liquidationBot";
import * as dotenv from "dotenv";
import { Argv, terminalWidth } from "yargs";
import yargs from "yargs/yargs";
import {
  exchangeWithProviderArgv,
  getExchangeWithProvider,
  getExchangeWithSigner,
  getNetwork,
  getProvider,
  getSigner,
  withNetworkArgv,
  withProviderArgv,
  withSignerArgv,
} from "@config/common";
import * as externalLiquidityIncentives from "./externalLiquidityIncentives";
import * as uniswap from "./uniswap";

const main = async () => {
  dotenv.config();

  await yargs(process.argv.slice(2))
    .command(
      ["changePosition"],
      "change position",
      async (yargs: Argv) => {
        return withSignerArgv(exchangeWithProviderArgv(yargs))
          .option("deltaAsset", {
            alias: "a",
            describe:
              "the amount of asset to change the position by denoted in wei",
            type: "string",
            require: true,
          })
          .option("deltaStable", {
            alias: "s",
            describe:
              "the amount of stable to change the position by denoted in wei",
            type: "string",
            require: true,
          })
          .option("stableBound", {
            alias: "b",
            describe: "max price trader is willing to pay denoted in wei",
            type: "string",
            default: "0",
          });
      },
      async (argv) => {
        const { deltaAsset, deltaStable, stableBound } = argv;

        const { signer, exchange } = getExchangeWithSigner(argv);

        const tx = await exchange.changePosition(
          deltaAsset,
          deltaStable,
          stableBound
        );

        await tx.wait();

        const position = await exchange.getPosition(await signer.getAddress());

        console.log({
          asset: position[0].toString(),
          stable: position[1].toString(),
        });
      }
    )
    .command(
      ["estimateChangePosition"],
      "estimate change position",
      async (yargs: Argv) => {
        return withSignerArgv(exchangeWithProviderArgv(yargs))
          .option("deltaAsset", {
            alias: "a",
            describe: "the amount of asset to change the position by",
            type: "string",
            require: true,
          })
          .option("deltaStable", {
            alias: "s",
            describe: "the amount of stable to change the position by",
            type: "string",
            require: true,
          })
          .option("stableBound", {
            alias: "b",
            describe: "max price trader is willing to pay",
            type: "string",
            default: "0",
          });
      },
      async (argv) => {
        const { deltaAsset, deltaStable, stableBound } = argv;

        const { exchange } = getExchangeWithSigner(argv);

        try {
          const trade = await exchange.callStatic.changePosition(
            deltaAsset,
            deltaStable,
            stableBound
          );

          console.log({
            startAsset: trade.startAsset.toString(),
            startStable: trade.startStable.toString(),
            totalAsset: trade.totalAsset.toString(),
            totalStable: trade.totalStable.toString(),
            tradeFee: trade.tradeFee.toString(),
            traderPayout: trade.traderPayout.toString(),
          });
        } catch (e) {
          console.log("Can not estimate trade");
          console.log({ e });
        }
      }
    )
    .command(
      ["approveTokens"],
      "approve_tokens",
      async (yargs: Argv) => withSignerArgv(exchangeWithProviderArgv(yargs)),
      async (argv: any) => {
        const { signer, exchange, exchangeAddress } =
          getExchangeWithSigner(argv);

        const assetTokenAddress = await exchange.assetToken();

        const assetToken = IERC20__factory.connect(assetTokenAddress, signer);

        const tx1 = await assetToken.approve(
          exchangeAddress,
          parseEther("100000")
        );
        await tx1.wait();

        const stableTokenAddress = await exchange.stableToken();

        const stableToken = IERC20__factory.connect(stableTokenAddress, signer);

        const tx2 = await stableToken.approve(
          exchangeAddress,
          parseEther("100000")
        );
        await tx2.wait();

        console.log(
          "Approved both tokens for account: " + (await signer.getAddress())
        );
      }
    )
    .command(
      ["liquidate"],
      "liquidate",
      async (yargs: Argv) =>
        withSignerArgv(exchangeWithProviderArgv(yargs)).option("trader", {
          alias: "t",
          describe: "the trader's address",
          type: "string",
          require: true,
        }),
      async (argv: any) => {
        const { exchange } = getExchangeWithSigner(argv);

        const tx = await exchange.liquidate(argv.trader);

        const receipt = await tx.wait();

        console.log("Liquidated in tx: " + receipt.transactionHash);
      }
    )
    .command(
      ["estimateLiquidate"],
      "estimate_liquidate",
      async (yargs: Argv) =>
        exchangeWithProviderArgv(yargs).option("trader", {
          alias: "t",
          describe: "the trader's address",
          type: "string",
          require: true,
        }),
      async (argv: any) => {
        const { exchange } = getExchangeWithProvider(argv);

        try {
          const payout = await exchange.callStatic.liquidate(argv.trader);
          console.log("Payout for liquidation: " + payout.toString());
        } catch (e) {
          console.log({ e });
          console.log("trade can not be liquidated");
        }
      }
    )
    .command(
      ["liquidationBot"],
      "run a bot to liquidate traders",
      (yargs: Argv) =>
        liquidationBot.cli(
          (yargs) => withSignerArgv(exchangeWithProviderArgv(yargs)),
          yargs
        ),
      async (argv) => await liquidationBot.run(getExchangeWithSigner, argv)
    )
    .command("uniswap", "Interaction with Uniswap", (yargs) =>
      uniswap.cli(
        withNetworkArgv,
        withProviderArgv,
        yargs,
        getNetwork,
        getProvider
      )
    )
    .command(
      "external-liquidity",
      "Incentives for liquidity provided on Uniswap",
      (yargs) =>
        externalLiquidityIncentives.cli(
          withSignerArgv,
          yargs,
          getNetwork,
          getSigner
        )
    )
    .demandCommand()
    .help()
    .strict()
    .wrap(Math.min(100, terminalWidth()))
    .parse();
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
