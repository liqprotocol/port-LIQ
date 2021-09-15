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
export PROGRAM_ID="Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR"
export CHECK_INTERVAL="1000.0"
```

`CHECK_INTERVAL` is the amount of milliseconds to wait between querying user's loan

### Run with yarn
```
yarn install
source .env
yarn pyth
```

### Run with Docker
```
docker-compose up --build -d
```

### Contribution
We welcome contributions. Substantial contribution is eligible for PORT token or USD rewards.
