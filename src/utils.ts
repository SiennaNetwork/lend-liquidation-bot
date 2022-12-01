import BigNumber from 'bignumber.js'

export async function retry<T>(func: () => Promise<T>, retries: number = 5): Promise<T> {
    do {
        try {
            const result = await func()

            return result
        } catch (e: any) {
            retries--

            // generic_err means the error was caused by contract logic,
            // so repeating the same request would yield the same result
            if (e.message) {
                console.error(`Caught error (retries left: ${retries}): ${e.message}`)

                if (e.stack)
                    console.error(`Trace: ${e.stack}`)

                if (e.message.includes('generic_err'))
                    throw e
            }
        }     
    } while(retries > 0)

    throw new Error('Ran out of retries for a single query or a TX.')
}

export function normalize_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.dividedBy(10 ** decimals)
}

export function raw_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.multipliedBy(10 ** decimals)
}

export function percentage_decrease(
    amount: BigNumber,
    nom: BigNumber.Value,
    denom: BigNumber.Value
): BigNumber {
    return amount.multipliedBy(nom).dividedBy(denom)
}

export function clamp(val: BigNumber, max: BigNumber): BigNumber {
    if (val.gt(max))
        return max

    return val
}
