import { SecretJS } from "siennajs"

import { get_value } from "./tx"

describe('TX', () => {
    test('Call get_value on pair swap response', () => {
        const json = String.raw`{"gasUsed":203270,"code":0,"arrayLog":[{"msg":0,"type":"message","key":"action","value":"/secret.compute.v1beta1.MsgExecuteContract"},{"msg":0,"type":"message","key":"module","value":"compute"},{"msg":0,"type":"message","key":"sender","value":"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy"},{"msg":0,"type":"message","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"offer_amount","value":"1000000"},{"msg":0,"type":"wasm","key":"swap_commission","value":"2800"},{"msg":0,"type":"wasm","key":"sienna_commission","value":"200"},{"msg":0,"type":"wasm","key":"spread_amount","value":"7248760601146"},{"msg":0,"type":"wasm","key":"commission_amount","value":"3000"},{"msg":0,"type":"wasm","key":"return_amount","value":"50735275106403008"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret1qnpz5n6uq8dhfkpmld2yxgaff4p27qps7maja5"},{"msg":0,"type":"wasm","key":"offer_token","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"action","value":"swap"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret12vy64457jysxf3x4hwr64425ztlauq98zchpgt"}],"jsonLog":[{"events":[{"type":"message","attributes":[{"key":"action","value":"/secret.compute.v1beta1.MsgExecuteContract"},{"key":"module","value":"compute"},{"key":"sender","value":"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy"},{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"}]},{"type":"wasm","attributes":[{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"offer_amount","value":"1000000"},{"key":"swap_commission","value":"2800"},{"key":"sienna_commission","value":"200"},{"key":"spread_amount","value":"7248760601146"},{"key":"commission_amount","value":"3000"},{"key":"return_amount","value":"50735275106403008"},{"key":"contract_address","value":"secret1qnpz5n6uq8dhfkpmld2yxgaff4p27qps7maja5"},{"key":"offer_token","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"action","value":"swap"},{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"contract_address","value":"secret12vy64457jysxf3x4hwr64425ztlauq98zchpgt"}]}],"msg_index":0}],"rawLog":"[{\"events\":[{\"type\":\"message\",\"attributes\":[{\"key\":\"action\",\"value\":\"/secret.compute.v1beta1.MsgExecuteContract\"},{\"key\":\"module\",\"value\":\"compute\"},{\"key\":\"sender\",\"value\":\"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy\"},{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"}]},{\"type\":\"wasm\",\"attributes\":[{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"},{\"key\":\"4pDMGzNeGoIZVwVu+2Ue9Sd5qQQZmx7HbSVYqA==\",\"value\":\"hUDNfnC/IOr8BOiaK9XASJ/+n4h9jUQ=\"},{\"key\":\"9ZSJNmnncVXnCR+ikrm7ilyI5CU0IQ/24XFMyZTiKA==\",\"value\":\"EcyCKYqvy9VMiB0nvVZHrSH9qf4=\"},{\"key\":\"MC7AB6PNXADsgQ/0GAGnqY8lEF2h4oGjc8WpULFLmGtX\",\"value\":\"jItbc14h+pfECzftHGyjrRd9FA==\"},{\"key\":\"Rd+pR7bJ5T52XJIC8UtqCxc5Z/k3cDQT0zazNqk=\",\"value\":\"2LPvC84fQVuZfgviMT5HLlE2ZD6y2E7WO6EaUiQ=\"},{\"key\":\"Tadzo9Ybzs99kK3i1NMNiITGuCy4RN2zGw+YQMPDdhoz\",\"value\":\"fPlIzJhAyG11FGGDPzPcXFnEI1M=\"},{\"key\":\"VszuaDcMMd1gy8PvFTiizZNcbJqLGLvvrf0tFYA=\",\"value\":\"n5ALBWImlOZDkuKDeCj2H3ISytfCwtZqe8tApB2ZRVae\"},{\"key\":\"contract_address\",\"value\":\"secret1qnpz5n6uq8dhfkpmld2yxgaff4p27qps7maja5\"},{\"key\":\"eZJI8bgL/LW5BDEn4dmi9tnXkzG2zPvaR9R1\",\"value\":\"0kN4Z2rDlVhq/6aSby8gT8DTM7hVrnbEsIHcjJTiVrLRl8QeQqIat6v64n0cCXFmnjzymE8atEdw4lxsgw==\"},{\"key\":\"vv6KN8GcvT53MM+wtbq+5KOcimPOgQ==\",\"value\":\"P+pb8yZxfv5l8SwnZKQ6jKh0YTM=\"},{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"},{\"key\":\"contract_address\",\"value\":\"secret12vy64457jysxf3x4hwr64425ztlauq98zchpgt\"}]}]}]"}`
        const resp: SecretJS.TxResponse = JSON.parse(json)

        const value = get_value(resp, 'return_amount')
        expect(value).toEqual('50735275106403008')
    })

    test('Call get_value on router swap response', () => {
        const json = String.raw`{"gasUsed":526639,"code":0,"arrayLog":[{"msg":0,"type":"message","key":"action","value":"/secret.compute.v1beta1.MsgExecuteContract"},{"msg":0,"type":"message","key":"module","value":"compute"},{"msg":0,"type":"message","key":"sender","value":"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy"},{"msg":0,"type":"message","key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"msg":0,"type":"wasm","key":"return_amount","value":"9363"},{"msg":0,"type":"wasm","key":"offer_token","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"msg":0,"type":"wasm","key":"sienna_commission","value":"20"},{"msg":0,"type":"wasm","key":"action","value":"swap"},{"msg":0,"type":"wasm","key":"offer_amount","value":"100000"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret1pak8feexy97myp22pjkxmsp5p8dmlkp4mkfxsl"},{"msg":0,"type":"wasm","key":"commission_amount","value":"300"},{"msg":0,"type":"wasm","key":"spread_amount","value":"0"},{"msg":0,"type":"wasm","key":"swap_commission","value":"280"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"return_amount","value":"9336"},{"msg":0,"type":"wasm","key":"offer_token","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"sienna_commission","value":"1"},{"msg":0,"type":"wasm","key":"action","value":"swap"},{"msg":0,"type":"wasm","key":"offer_amount","value":"9363"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret19x5hnfsx995wqwfa5czn74ayjkc3vn8rw6fkz7"},{"msg":0,"type":"wasm","key":"commission_amount","value":"27"},{"msg":0,"type":"wasm","key":"spread_amount","value":"0"},{"msg":0,"type":"wasm","key":"swap_commission","value":"26"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret16020v7p5r3yxx5xcazresywykglxemnx69q2xe"},{"msg":0,"type":"wasm","key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"}],"jsonLog":[{"events":[{"type":"message","attributes":[{"key":"action","value":"/secret.compute.v1beta1.MsgExecuteContract"},{"key":"module","value":"compute"},{"key":"sender","value":"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy"},{"key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"}]},{"type":"wasm","attributes":[{"key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"},{"key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"key":"return_amount","value":"9363"},{"key":"offer_token","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"key":"sienna_commission","value":"20"},{"key":"action","value":"swap"},{"key":"offer_amount","value":"100000"},{"key":"contract_address","value":"secret1pak8feexy97myp22pjkxmsp5p8dmlkp4mkfxsl"},{"key":"commission_amount","value":"300"},{"key":"spread_amount","value":"0"},{"key":"swap_commission","value":"280"},{"key":"contract_address","value":"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8"},{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"},{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"return_amount","value":"9336"},{"key":"offer_token","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"sienna_commission","value":"1"},{"key":"action","value":"swap"},{"key":"offer_amount","value":"9363"},{"key":"contract_address","value":"secret19x5hnfsx995wqwfa5czn74ayjkc3vn8rw6fkz7"},{"key":"commission_amount","value":"27"},{"key":"spread_amount","value":"0"},{"key":"swap_commission","value":"26"},{"key":"contract_address","value":"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg"},{"key":"contract_address","value":"secret16020v7p5r3yxx5xcazresywykglxemnx69q2xe"},{"key":"contract_address","value":"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038"}]}],"msg_index":0}],"rawLog":"[{\"events\":[{\"type\":\"message\",\"attributes\":[{\"key\":\"action\",\"value\":\"/secret.compute.v1beta1.MsgExecuteContract\"},{\"key\":\"module\",\"value\":\"compute\"},{\"key\":\"sender\",\"value\":\"secret1vdf2hz5f2ygy0z7mesntmje8em5u7vxknyeygy\"},{\"key\":\"contract_address\",\"value\":\"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8\"}]},{\"type\":\"wasm\",\"attributes\":[{\"key\":\"contract_address\",\"value\":\"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8\"},{\"key\":\"contract_address\",\"value\":\"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038\"},{\"key\":\"contract_address\",\"value\":\"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8\"},{\"key\":\"+r+i4/na/KXbuh1X/IJDQsVw/gS+PGycifEcJeM=\",\"value\":\"wXci6JsrElY9qWiodn+whRAqtkI=\"},{\"key\":\"67RxtvxWHxHKsGVJJ8fNO0o2qcyDXw3ILTxx\",\"value\":\"NOBCyHVE9FHxLsVqB0D+bOrxnd6H744d2mBRNcjGwUfspEQcwH3rXX2+daHN06jV5b3XcC44/855687x1A==\"},{\"key\":\"9Nggc+HmErGVNoyBUFTjtaSD9H/AcsTubRuqO7w51vHe\",\"value\":\"CcUqe7pBty8vmT1os/R6aVwy\"},{\"key\":\"F3eLA87kDfA30H40oHlxqttVYhXYxA==\",\"value\":\"aH2pmx0j7x8xyuHux+fMWpe4TMQ=\"},{\"key\":\"JHAoo4cKIdEnZtIZe5TmN+kE/Unx+SyVCLehcg==\",\"value\":\"gw/HL9O9CpBSGAxavmqJ0XoutxyPNw==\"},{\"key\":\"contract_address\",\"value\":\"secret1pak8feexy97myp22pjkxmsp5p8dmlkp4mkfxsl\"},{\"key\":\"hjEUQm5cJsUQ2NqbVC0zzaRlYCsZtffcf/geLYaPhqcM\",\"value\":\"k1af+djJhUE4wbunjeIvq9CD7w==\"},{\"key\":\"j0Ehs+ANX/QoBr69kKSr7pyYzlZMm61aYlbiAgU=\",\"value\":\"rLIJahYDaC/kjcO1w9ZQwlQ=\"},{\"key\":\"me70nxsFk2trvagxIt9dCzUaHnika34pDCFtrIGVaw==\",\"value\":\"45e1xmzNDHNRKBZ4G6KYKfNdpg==\"},{\"key\":\"contract_address\",\"value\":\"secret19ymc8uq799zf36wjsgu4t0pk8euddxtx5fggn8\"},{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"},{\"key\":\"contract_address\",\"value\":\"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038\"},{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"},{\"key\":\"+r+i4/na/KXbuh1X/IJDQsVw/gS+PGycifEcJeM=\",\"value\":\"XozBaYCLFlR8VVGTvYMCDSdPDUA=\"},{\"key\":\"67RxtvxWHxHKsGVJJ8fNO0o2qcyDXw3ILTxx\",\"value\":\"B+9T+34hXVk+tjrBuLn+hlXXVHODPfM6d/VUwuV2xPjITbZHmjlwLTUO+TF1NMmmjN3gnC1H5mWJ6VENQw==\"},{\"key\":\"9Nggc+HmErGVNoyBUFTjtaSD9H/AcsTubRuqO7w51vHe\",\"value\":\"J+uvBEQ4OLk0LH6LVKqCLy8=\"},{\"key\":\"F3eLA87kDfA30H40oHlxqttVYhXYxA==\",\"value\":\"aH2pmx0j7x8xyuHux+fMWpe4TMQ=\"},{\"key\":\"JHAoo4cKIdEnZtIZe5TmN+kE/Unx+SyVCLehcg==\",\"value\":\"wXci6JsrElY9qWiodn+whRAqtkI=\"},{\"key\":\"contract_address\",\"value\":\"secret19x5hnfsx995wqwfa5czn74ayjkc3vn8rw6fkz7\"},{\"key\":\"hjEUQm5cJsUQ2NqbVC0zzaRlYCsZtffcf/geLYaPhqcM\",\"value\":\"GQE6xAGC4NW5G1RMgJpydNwz\"},{\"key\":\"j0Ehs+ANX/QoBr69kKSr7pyYzlZMm61aYlbiAgU=\",\"value\":\"rLIJahYDaC/kjcO1w9ZQwlQ=\"},{\"key\":\"me70nxsFk2trvagxIt9dCzUaHnika34pDCFtrIGVaw==\",\"value\":\"ilV2LtyUdLBc7tdRwJ7iHOJW\"},{\"key\":\"contract_address\",\"value\":\"secret18vd8fpwxzck93qlwghaj6arh4p7c5n8978vsyg\"},{\"key\":\"contract_address\",\"value\":\"secret16020v7p5r3yxx5xcazresywykglxemnx69q2xe\"},{\"key\":\"contract_address\",\"value\":\"secret1g7lswpdcpx3wer07ydw3cza4pcm5kxu6qkp038\"}]}]}]"}`
        const resp: SecretJS.TxResponse = JSON.parse(json)

        const value = get_value(resp, 'return_amount')
        expect(value).toEqual('9336')
    })
})
