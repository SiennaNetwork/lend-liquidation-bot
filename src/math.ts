import BigNumber from 'bignumber.js'

export function normalize_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.dividedBy(10 ** decimals)
}

export function raw_denom(amount: BigNumber, decimals: number): BigNumber {
    return amount.multipliedBy(10 ** decimals)
}

export function decrease_by_percent(
    amount: BigNumber,
    nom: BigNumber.Value,
    denom: BigNumber.Value
): BigNumber {
    return amount.multipliedBy(nom).dividedBy(denom)
}

export function percentage_diff(initial: BigNumber, final: BigNumber): number {
    if (final >= initial)
        return 0

    const diff = initial.minus(final)
    
    return diff.dividedBy(initial).multipliedBy(100).toNumber()
}

export function clamp(val: BigNumber, max: BigNumber): BigNumber {
    if (val.gt(max))
        return max

    return val
}
