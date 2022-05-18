# SiennaLend Liquidation Bot

## Requirements
 - NodeJS 17.5
 - Yarn Package Manager

## Setup and running the bot
 1. `yarn install`
 2. Create a `config.yml` file - look at `config.yml.example` for more info
 3. `sh run.sh`

## How it works
The bot initially takes the configured markets and checks your wallet balance in each underlying token for each market, using the provided viewing keys.
Then it runs the liquidation logic every X amount of seconds (as configured). Each liquidation round consists of the following:
 - Query latest token prices from the Band oracle.
 - Look into each of the configured markets for the most suitable loan to liquidate.
 - Select the most profitable one out of all the best candidates (if any) and liquidate it.

Once the wallet balance runs out in a given market, it is no longer looked into. When this happens for all markets, the bot ceases execution.
The UST and Luna markets are **excluded** from the bot logic - the bot will not look into loans inside these markets (even if configured)
and will never seize any collateral that a borrower might be providing for these two.

## Algorithm
The bot aims to select a suitable candidate to liquidate in the lowest amount of queries possible. Since finding out whether a borrower actually possesses 
the desired seize amount of collateral in a single asset can only be achieved by directly querying the market contract, the eligible for liquidation
borrowers are sorted according to a certain criteria and these are looked at first. Currently, this criteria is: collaterals that have the highest price
are prioritized. And that also depends on the amount that is owed by the borrower and the amount that the wallet can repay. So if a borrower has WBTC
as collateral, that will be looked at first. This means that if stable coins are the most desirable asset, you will need to tweak the logic slightly.
In any case, it is very desirable to get acquainted with how the algorithm works before actually running it. There are two functions of interest to
look at inside `src/Liquidator.ts`: `find_best_candidate` and `process_candidate`. The rest of the logic will most likely require no additional changes
if all that you want to change is the loan selection algorithm.

## Disclaimer
All Code is presented under the GNU AFFERO GENERAL PUBLIC LICENSE version 3 and as a consequence the "Sienna DAO" doesn’t claim
any intellectual property rights to the software, which may be seen as an example/starting point for anyone who wishes to participate
in liquidations on the open-sourced SiennaLend Protocol. Any use is completely at your own risk.
