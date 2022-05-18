import { ExecuteResult, SigningCosmWasmClient } from "secretjs";
import { Coin, StdFee } from "secretjs/types/types";

const QUERY_RETRIES = 6
const TX_RETRIES = 3

export class ScrtClient extends SigningCosmWasmClient {
    public override async queryContractSmart(
        contractAddress: string,
        queryMsg: object,
        addedParams?: object,
        contractCodeHash?: string
    ): Promise<any> {
        return this.retry(
            async () => super.queryContractSmart(contractAddress, queryMsg, addedParams, contractCodeHash),
            QUERY_RETRIES
        )
    }

    public override async execute(
        contractAddress: string,
        handleMsg: object,
        memo?: string,
        transferAmount?: readonly Coin[],
        fee?: StdFee,
        contractCodeHash?: string
    ): Promise<ExecuteResult> {
        return this.retry(
            async () => super.execute(contractAddress, handleMsg, memo, transferAmount, fee, contractCodeHash),
            TX_RETRIES
        )
    }

    private async retry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
        do {
            try {
                const result = await fn()

                return result
            } catch (e: any) {
                // generic_err means the error was caused by contract logic,
                // so repeating the same request would yield the same result
                if (e.message && e.message.includes('generic_err')) {
                    throw e
                }

                retries--
            }     
        } while(retries > 0)

        throw new Error(`${this.constructor.name}: ran out of retries.`)
    }
}
