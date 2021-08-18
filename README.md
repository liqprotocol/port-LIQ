# Port Finance Loan Liquidator

## Setup Liquidator
### Prerequisites
To run the liquidator you will need:
* A Solana account with some SOL deposited to cover transaction fees
* Token accounts for each token in the reserve
* Roughly equal deposits for each token.
### Setup
Make sure to edit the .env file to look something like this:
```
export CLUSTER="mainnet-beta"
export CLUSTER_URL="https://solana-api.projectserum.com"
export KEYPAIR=~/.config/solana/id.json
export NODE_ENV=production
export CHECK_INTERVAL="1000.0"
```

`CHECK_INTERVAL` is the amount of milliseconds to wait between querying user's loan

### Run
```
yarn install
source .env
yarn pyth
```

| Asset Name      | Reserve Address | pToken Mint  |  Oracle Pubkey  |
| :---  |    :----:                                           |          :---:                                  |  ---:                                         |
| SOL   | X9ByyhmtQH3Wjku9N5obPy54DbVjZV7Z99TPJZ2rwcs         | 8ezDtNNhX91t1NbSLe8xV2PcCEfoQjEm2qDVGjt3rjhg    |  H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG |
| USDC  | DcENuKuYd6BWGhKfGr7eARxodqG12Bz1sN5WA8NwvLRx        | FgSsGV8GByPaMERxeQJPvZRZHf7zCBhrdYtztKorJS58    | Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD  |
| USDT  | 4tqY9Hv7e8YhNQXuH75WKrZ7tTckbv2GfFVxmVcScW5s        | 3RudPTAkfcq9Q9Jk8SVeCoecCBmdKMj6q5smsWzxqtqZ    |  3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL |
| PAI   | DSw99gXoGzvc4N7cNGU7TJ9bCWFq96NU2Cczi1TabDx2        | GaqxUwFGGrDouYLqghchmZU97Y1rNhyF7noMTJNvpQPa    |    N/A                                        |
| SRM   | ZgS3sv1tJAor2rbGMFLeJwxsEGDiHkcrR2ZaNHZUpyF         | 77TBgKmTNtMdGrt1ewNRb56F2Xw6fNLZZj33JZ3oGwXh    | 3NBReDRTLKMQEKiLD5tGcx4kXbTf88b7f2xLS9UuGjym  |
| BTC   | DSST29PMCVkxo8cf5ht9LxrPoMc8jAZt98t6nuJywz8p        | QN2HkkBaWHfYSU5bybyups9z1UHu8Eu7QeeyMbjD2JA     | GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU  |
| MER   | BnhsmYVvNjXK3TGDHLj1Yr1jBGCmD1gZMkAyCwoXsHwt        | 6UgGnLA3Lfe8NBLAESctsUXWdP3zjMFzSLEZxS3tiaKh    | G4AQpTYKH1Fmg38VpFQbv6uKYQMpRhJzNPALhp7hqdrs  |
