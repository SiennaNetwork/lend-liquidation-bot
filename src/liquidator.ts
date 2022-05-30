import {
    Secp256k1Pen, EnigmaUtils, encodeSecp256k1Pubkey, pubkeyToAddress
} from "secretjs";
import { lend, snip20, Address, ViewingKey, Pagination, create_fee } from "siennajs";
import BigNumber from 'bignumber.js'
import fetch from 'node-fetch';
import { ScrtClient } from './client'

BigNumber.config({
    EXPONENTIAL_AT: 1e9,
    ROUNDING_MODE: BigNumber.ROUND_DOWN
})

const LIQUIDATE_COST = 550_000
const BLACKLISTED_SYMBOLS = ['LUNA', 'UST']

export interface Config {
    markets: MarketConfig[],
    band_url: string,
    api_url: string,
    chain_id: string,
    mnemonic: string,
    interval: number,
    overseer: Address
}

export interface MarketConfig {
    address: Address,
    underlying_vk: ViewingKey
}

interface Market {
    contract: lend.MarketContract,
    decimals: number,
    symbol: string,
    user_balance: BigNumber
}

interface LendConstants {
    close_factor: number,
    premium: number
}

interface Candidate {
    id: string,
    payable: BigNumber,
    seizable_usd: BigNumber,
    market_info: lend.Market
}

interface PriceResult {
    symbol: string,
    multiplier: string,
    px: string,
    request_id: string,
    resolve_time: string
}

export class Liquidator {
    private handle?: NodeJS.Timer
    private is_executing: boolean = false
    private prices: Record<string, number> = { }
    private current_height = 0

    static async create(config: Config): Promise<Liquidator> {
        const client = await build_client(config.mnemonic, config.api_url)
        
        const overseer = new lend.OverseerContract(config.overseer, client)

        const overseer_config = await overseer.query().config()
        const constants = {
            close_factor: parseFloat(overseer_config.close_factor),
            premium: parseFloat(overseer_config.premium)
        }

        const all_markets = await fetch_all_pages(
            (page) => overseer.query().markets(page),
            30,
            (x) => !BLACKLISTED_SYMBOLS.includes(x.symbol)
        )

        const markets: Market[] = []

        for(const market_config of config.markets) {
            const match = all_markets.find(x => x.contract.address == market_config.address)

            if (!match) {
                throw new Error(`Market ${market_config.address} doesn't exist in overseer ${config.overseer}`)
            }

            const contract = new lend.MarketContract(market_config.address, client)

            // Fetch user balance for this underlying token.
            const token = await contract.query().underlying_asset()

            const token_contract = new snip20.Snip20Contract(token.address, client)
            const balance = await token_contract.query().get_balance(client.senderAddress, market_config.underlying_vk)

            if (balance != '0') {
                const market: Market = {
                    contract,
                    decimals: match.decimals,
                    symbol: match.symbol,
                    user_balance: new BigNumber(balance)
                }

                markets.push(market)
            }
        }

        const price_symbols = new Set(all_markets.map(x => x.symbol))
        price_symbols.add('SCRT') // We always need SCRT, in order to check gas costs

        console.log('Operating with markets:')
        markets.forEach((x) => {
            console.log(`Market: ${x.contract.address}`)
            console.log(`Wallet balance: ${x.user_balance}\n`)
        })

        return new this(
            client,
            config,
            markets,
            [...price_symbols],
            constants
        )
    }
    
    private constructor(
        private client: ScrtClient,
        private config: Config,
        private markets: Market[],
        private price_symbols: string[],
        private constants: LendConstants
    ) { }

    start() {
        this.handle = setInterval(
            async () => this.run_liquidations_round(),
            this.config.interval
        )
    }

    stop() {
        if (this.handle) {
            clearInterval(this.handle)
        }
    }

    async run_once() {
        return this.run_liquidations_round()
    }

    private async run_liquidations_round() {
        if (this.is_executing) {
            return
        }

        if (this.markets.length == 0) {
            console.log('Wallet underlying balance in all markets is 0. Terminating...')
            this.stop()

            return
        }

        this.is_executing = true

        try {
            const block = await this.client.getBlock()

            if (!block) {
                console.log("Couldn't fetch latest block info. Skipping round...")
    
                return
            }
    
            this.current_height = block.header.height
            await this.fetch_prices()
    
            const candidates = await Promise.all(this.markets.map(x => this.market_candidate(x)))
            let best_loan: Candidate | null = candidates[0]
            let index = 0
    
            candidates.forEach((loan, i) => {
                if (!loan)
                    return
    
                if (!best_loan || best_loan.seizable_usd.lt(loan.seizable_usd)) {
                    best_loan = loan
                    index = i
                }
            })
    
            if (!best_loan) {
                console.log("Couldn't find a good loan to liquidate this round...")
    
                return
            }

            const market = this.markets[index]
            const result = await market.contract.exec(
                create_fee(LIQUIDATE_COST.toString())
            ).liquidate(
                best_loan.payable.toFixed(0),
                best_loan.id,
                best_loan.market_info.contract.address
            )

            const repaid_amount = normalize_denom(best_loan.payable, market.decimals)
            console.log(`Successfully liquidated a loan by repaying ${repaid_amount.toString()} ${market.symbol} and seized ~$${best_loan.seizable_usd} worth of ${best_loan.market_info.symbol} (transfered to market: ${best_loan.market_info.contract.address})!`)
            console.log(`TX hash: ${result.transactionHash}`)

            market.user_balance = market.user_balance.minus(best_loan.payable)

            if (market.user_balance.isZero()) {
                console.log(`Ran out of balance for market ${market.contract.address}. Removing...`)
                this.markets.splice(index, 1)
            }
        } catch (e) {
            console.log(`Caught an error during liquidations round: ${e}`)
        } finally {
            this.is_executing = false
        }
    }

    private async fetch_prices() {
        const symbols = this.price_symbols.map(x => `symbols=${x}`)
        
        const resp = await fetch(`${this.config.band_url}/oracle/v1/request_prices?${symbols.join('&')}`)
        const prices: {price_results: PriceResult[]} = await resp.json()

        prices.price_results.forEach((x: any) => {
            const price = new BigNumber(x.px).dividedBy(x.multiplier).toNumber()
            this.prices[x.symbol] = price
        })
    }

    private async market_candidate(market: Market): Promise<Candidate | null> {
        const candidates = await fetch_all_pages(
            (page) => market.contract.query().borrowers(page, this.current_height),
            10,
            (x) => {
                if (x.liquidity.shortfall == '0')
                    return false

                x.markets = x.markets.filter(m => !BLACKLISTED_SYMBOLS.includes(m.symbol))

                return x.markets.length != 0
            }
        )

        if (candidates.length == 0) {
            console.log(`No liquidatable loans currently in ${market.contract.address}. Skipping...`)

            return null
        }

        return this.find_best_candidate(market, candidates)
    }

    private async find_best_candidate(market: Market, borrowers: lend.MarketBorrower[]): Promise<Candidate | null> {
        const exchange_rate_request = market.contract.query().exchange_rate(this.current_height)

        const sort_by_price = (a: lend.Market, b: lend.Market) => {
            const price_a = this.prices[a.symbol]
            const price_b = this.prices[b.symbol]

            return price_b - price_a
        }
        borrowers.forEach(x => x.markets.sort(sort_by_price))

        const calc_net = (borrower: lend.MarketBorrower) => {
            const payable = this.payable(market, borrower)

            return payable.multipliedBy(this.constants.premium)
                .multipliedBy(this.prices[market.symbol])
                .dividedBy(this.prices[borrower.markets[0].symbol])
        }

        borrowers.sort((a, b) => {
            const net_a = calc_net(a)
            const net_b = calc_net(b)

            if (net_a.isEqualTo(net_b)) {
                return sort_by_price(a.markets[0], b.markets[0])
            }

            return net_a.minus(net_b).toNumber()
        })
        
        const exchange_rate = new BigNumber(await exchange_rate_request)
        let best_candidate: Candidate | null = null
        
        // Because we sort the borrowers based on the best case scenario
        // (where full liquidation is possible and receiving the best priced collateral)
        // we can only make assumptions about whether the current loan is the best one to liquidate
        // if we hit the best case scenario for it. So we compare loans in pairs, starting from the `hypothetical`
        // best one and stopping as soon as the best case was encountered for either loan in the current pair.
        // Otherwise, continue to the next pair.
        for(let i = 0; i < borrowers.length; i++) {
            const a = await this.process_candidate(market, borrowers[i], exchange_rate)

            if (a.best_case || i == borrowers.length - 1) {
                best_candidate = a.candidate

                break
            }

            const b = await this.process_candidate(market, borrowers[i + 1], exchange_rate)

            if (b.candidate.seizable_usd.gt(a.candidate.seizable_usd)) {
                best_candidate = b.candidate

                if (b.best_case) {
                    break
                }
            } else {
                best_candidate = a.candidate

                break
            }

            i += 1
        }

        const tx_cost = normalize_denom(new BigNumber(LIQUIDATE_COST * this.prices['SCRT']), 6)

        if (best_candidate && tx_cost.gt(best_candidate.seizable_usd))
            return null

        return best_candidate
    }

    private async process_candidate(
        market: Market,
        borrower: lend.MarketBorrower,
        exchange_rate: BigNumber
    ): Promise<{ best_case: boolean, candidate: Candidate }> {
        const payable = this.payable(market, borrower)

        let best_seizable_usd = new BigNumber(0)
        let best_payable = new BigNumber(0)
        let market_index = 0

        for (let i = 0; i < borrower.markets.length; i++) {
            const m = borrower.markets[i];

            // Values are in sl-tokens so we need to convert to
            // the underlying in order for them to be useful here.
            const info = await market.contract.query().simulate_liquidation(
                borrower.id,
                m.contract.address,
                payable.toFixed(0),
                this.current_height
            )

            const seizable = new BigNumber(info.seize_amount).multipliedBy(exchange_rate)

            if (i == 0 && info.shortfall == '0') {
                // We can liquidate using the most profitable asset so no need to go further.
                return {
                    best_case: true,
                    candidate: {
                        id: borrower.id,
                        payable,
                        seizable_usd: normalize_denom(seizable.multipliedBy(this.prices[m.symbol]), m.decimals),
                        market_info: m
                    }
                }
            }

            let actual_payable;
            let actual_seizable_usd;

            let done = false

            if(info.shortfall == '0') {
                actual_payable = payable
                actual_seizable_usd = normalize_denom(seizable.multipliedBy(this.prices[m.symbol]), m.decimals)

                // We don't have to check further since this is the second best scenario that we've got.
                done = true
            } else {
                // Otherwise check by how much we'd need to decrease our repay amount in order for the
                // liquidation to be successful and also decrease the seized amount by that percentage.
                const actual_seizable = new BigNumber(info.seize_amount).minus(info.shortfall)

                if (actual_seizable.isZero()) {
                    actual_payable = new BigNumber(0)
                    actual_seizable_usd = new BigNumber(0)
                } else {
                    const seizable_price = actual_seizable.multipliedBy(this.prices[m.symbol]).multipliedBy(exchange_rate)
                    const borrowed_premium = new BigNumber(this.constants.premium).multipliedBy(this.prices[market.symbol])
                
                    actual_payable = seizable_price.dividedBy(borrowed_premium)
    
                    actual_seizable_usd = normalize_denom(
                        actual_seizable.multipliedBy(this.prices[m.symbol]),
                        m.decimals
                    )
                }
            }

            if (actual_seizable_usd.gt(best_seizable_usd)) {
                best_payable = actual_payable
                best_seizable_usd = actual_seizable_usd
                market_index = i

                if (done)
                    break
            }
        }

        return {
            best_case: false,
            candidate: {
                id: borrower.id,
                payable: best_payable,
                seizable_usd: best_seizable_usd,
                market_info: borrower.markets[market_index]
            }
        }
    }

    private payable(market: Market, borrower: lend.MarketBorrower): BigNumber {
        return clamp(
            new BigNumber(borrower.actual_balance).multipliedBy(this.constants.close_factor),
            market.user_balance
        )
    }
}

function clamp(val: BigNumber, max: BigNumber) {
    if (val.gt(max))
        return max

    return val
}

function normalize_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.dividedBy(10 ** decimals)
}

async function fetch_all_pages<T>(
    query: (pagination: Pagination) => Promise<lend.PaginatedResponse<T>>,
    limit: number,
    filter?: (x: T) => boolean
): Promise<T[]> {
    let start = 0;
    let total = 0;

    const result: T[] = []

    do {
        const page = await query({
            start,
            limit
        })

        total = page.total
        start += limit

        if (filter) {
            page.entries.forEach(x => {
                if (filter(x))
                    result.push(x)
            })
        } else {
            page.entries.forEach(x => result.push(x))
        }

    } while(start <= total)

    return result
}

async function build_client(mnemonic: string, api_url: string): Promise<ScrtClient> {
    const pen = await Secp256k1Pen.fromMnemonic(mnemonic)
    const seed = EnigmaUtils.GenerateNewSeed();
  
    const pubkey  = encodeSecp256k1Pubkey(pen.pubkey)
    const address = pubkeyToAddress(pubkey, 'secret')
  
    return new ScrtClient(
        api_url,
        address,
        (bytes) => pen.sign(bytes),
        seed
    )
}
