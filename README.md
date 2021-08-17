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

pToken mint
```
FgSsGV8GByPaMERxeQJPvZRZHf7zCBhrdYtztKorJS58 - USDC
GaqxUwFGGrDouYLqghchmZU97Y1rNhyF7noMTJNvpQPa - PAI
8ezDtNNhX91t1NbSLe8xV2PcCEfoQjEm2qDVGjt3rjhg - SOL
3RudPTAkfcq9Q9Jk8SVeCoecCBmdKMj6q5smsWzxqtqZ - USDT
77TBgKmTNtMdGrt1ewNRb56F2Xw6fNLZZj33JZ3oGwXh - SRM
```