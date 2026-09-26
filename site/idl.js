export const IDL = {
  "address": "3VQsTJGWQ1L4t312R527475JKUuSjsbSjbQoKbFqKoQS",
  "metadata": {
    "name": "balls_bond",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Balls founder-bond escrow for pump.fun launches"
  },
  "instructions": [
    {
      "name": "claim_bond",
      "docs": [
        "Founder takes the collateral back once the coin's market cap has",
        "reached the target (or the coin graduated off the pump.fun curve)."
      ],
      "discriminator": [
        173,
        34,
        157,
        61,
        45,
        120,
        246,
        11
      ],
      "accounts": [
        {
          "name": "founder",
          "writable": true,
          "signer": true
        },
        {
          "name": "bond",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "bond.mint",
                "account": "Bond"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "bond"
              }
            ]
          }
        },
        {
          "name": "pump_curve"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "create_bond",
      "docs": [
        "Founder-only. Locks `collateral` lamports against a market-cap",
        "`target_mcap` (lamports) for a coin the founder created on pump.fun.",
        "Rides in the same transaction as pump.fun's `create_v2`."
      ],
      "discriminator": [
        96,
        81,
        70,
        166,
        111,
        33,
        61,
        50
      ],
      "accounts": [
        {
          "name": "founder",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint",
          "docs": [
            "The pump.fun coin's mint."
          ]
        },
        {
          "name": "pump_curve",
          "docs": [
            "The coin's pump.fun bonding curve."
          ]
        },
        {
          "name": "bond",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "bond"
              }
            ]
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "target_mcap",
          "type": "u64"
        },
        {
          "name": "collateral",
          "type": "u64"
        }
      ]
    },
    {
      "name": "init_config",
      "docs": [
        "One-time setup by the program's upgrade authority: names the admin",
        "`resolver` wallet and the automated `keeper` wallet — the only two",
        "that may trigger burns of expired, unmet bonds."
      ],
      "discriminator": [
        23,
        235,
        115,
        232,
        168,
        96,
        1,
        231
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Must be the program's upgrade authority — otherwise anyone could",
            "front-run the deployer and install themselves as resolver."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "program",
          "address": "3VQsTJGWQ1L4t312R527475JKUuSjsbSjbQoKbFqKoQS"
        },
        {
          "name": "program_data"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "resolver",
          "type": "pubkey"
        },
        {
          "name": "keeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "refund_stuck",
      "docs": [
        "Founder escape hatch: reclaim an expired, unmet bond that nobody",
        "managed to resolve for `STUCK_GRACE_SECS`."
      ],
      "discriminator": [
        225,
        137,
        94,
        251,
        252,
        138,
        99,
        88
      ],
      "accounts": [
        {
          "name": "founder",
          "writable": true,
          "signer": true
        },
        {
          "name": "bond",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "bond.mint",
                "account": "Bond"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "bond"
              }
            ]
          }
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "resolve_bond",
      "docs": [
        "Resolver- or keeper-only, after the deadline and only if the target is unmet:",
        "buys the coin on pump.fun with the collateral and burns every token",
        "bought."
      ],
      "discriminator": [
        17,
        66,
        218,
        137,
        85,
        246,
        52,
        220
      ],
      "accounts": [
        {
          "name": "resolver",
          "docs": [
            "Only the resolver or keeper wallet named in Config may trigger a burn. It pays the tx",
            "fee (and the vault token account's rent if it doesn't exist yet) and",
            "cannot redirect any value — see the handler."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "bond",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  111,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "bond.mint",
                "account": "Bond"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "bond"
              }
            ]
          }
        },
        {
          "name": "founder",
          "docs": [
            "Receives whatever lamports the buy leaves in the vault (rent dust)."
          ],
          "writable": true
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "vault_token_account",
          "docs": [
            "The vault's own token account for the coin — it receives the bought",
            "tokens and they are burned straight out of it. Must already exist",
            "(the client creates it in the same transaction)."
          ],
          "writable": true
        },
        {
          "name": "token_program"
        },
        {
          "name": "pump_program",
          "address": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
        },
        {
          "name": "pump_global"
        },
        {
          "name": "pump_fee_recipient",
          "writable": true
        },
        {
          "name": "pump_curve",
          "writable": true
        },
        {
          "name": "pump_curve_token_account",
          "writable": true
        },
        {
          "name": "pump_creator_vault",
          "writable": true
        },
        {
          "name": "pump_event_authority"
        },
        {
          "name": "pump_global_volume_accumulator"
        },
        {
          "name": "pump_user_volume_accumulator",
          "writable": true
        },
        {
          "name": "pump_fee_config"
        },
        {
          "name": "pump_fee_program"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "min_tokens_out",
          "type": "u64"
        }
      ]
    },
    {
      "name": "set_keeper",
      "docs": [
        "Resolver swaps the keeper's hot key."
      ],
      "discriminator": [
        102,
        94,
        23,
        78,
        157,
        222,
        243,
        214
      ],
      "accounts": [
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "new_keeper",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "set_resolver",
      "docs": [
        "Current resolver hands the admin role to another wallet."
      ],
      "discriminator": [
        137,
        108,
        27,
        51,
        202,
        16,
        33,
        119
      ],
      "accounts": [
        {
          "name": "resolver",
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "new_resolver",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "Bond",
      "discriminator": [
        224,
        128,
        48,
        251,
        182,
        246,
        111,
        196
      ]
    },
    {
      "name": "Config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    }
  ],
  "events": [
    {
      "name": "BondBurned",
      "discriminator": [
        141,
        35,
        247,
        125,
        204,
        198,
        51,
        197
      ]
    },
    {
      "name": "BondClaimed",
      "discriminator": [
        4,
        151,
        48,
        253,
        112,
        78,
        238,
        101
      ]
    },
    {
      "name": "BondCreated",
      "discriminator": [
        75,
        123,
        213,
        125,
        66,
        232,
        46,
        147
      ]
    },
    {
      "name": "BondRefunded",
      "discriminator": [
        52,
        32,
        75,
        36,
        37,
        139,
        123,
        17
      ]
    },
    {
      "name": "KeeperChanged",
      "discriminator": [
        194,
        174,
        248,
        100,
        222,
        104,
        243,
        108
      ]
    },
    {
      "name": "ResolverChanged",
      "discriminator": [
        6,
        235,
        225,
        252,
        79,
        239,
        195,
        145
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "InvalidPumpCurve",
      "msg": "The provided account is not a valid pump.fun bonding curve for this mint"
    },
    {
      "code": 6001,
      "name": "NotCoinCreator",
      "msg": "Only the wallet that created this coin on pump.fun can post a bond for it"
    },
    {
      "code": 6002,
      "name": "CoinGraduated",
      "msg": "This coin has already graduated from the pump.fun curve"
    },
    {
      "code": 6003,
      "name": "TargetTooLow",
      "msg": "Target market cap must be above the coin's current market cap"
    },
    {
      "code": 6004,
      "name": "CollateralTooLow",
      "msg": "Collateral is below the minimum"
    },
    {
      "code": 6005,
      "name": "BondNotActive",
      "msg": "This bond is no longer active"
    },
    {
      "code": 6006,
      "name": "TargetNotReached",
      "msg": "The bond's market-cap target has not been reached"
    },
    {
      "code": 6007,
      "name": "TargetReached",
      "msg": "The bond's target is reached - the founder can claim it, it cannot be burned"
    },
    {
      "code": 6008,
      "name": "NotExpired",
      "msg": "The bond's deadline has not passed yet"
    },
    {
      "code": 6009,
      "name": "NotFounder",
      "msg": "Only the wallet that posted this bond may do this"
    },
    {
      "code": 6010,
      "name": "NothingBought",
      "msg": "The buy on pump.fun returned no tokens"
    },
    {
      "code": 6011,
      "name": "SlippageExceeded",
      "msg": "Slippage: pump.fun returned fewer tokens than allowed"
    },
    {
      "code": 6012,
      "name": "GraceNotElapsed",
      "msg": "The stuck-bond grace period has not passed yet"
    },
    {
      "code": 6013,
      "name": "BadPumpAccount",
      "msg": "A supplied pump.fun account does not match the expected address"
    },
    {
      "code": 6014,
      "name": "MathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "NotResolver",
      "msg": "Only the resolver wallet may trigger a burn"
    },
    {
      "code": 6016,
      "name": "NotUpgradeAuthority",
      "msg": "Only the program's upgrade authority may initialize the config"
    },
    {
      "code": 6017,
      "name": "InvalidAddress",
      "msg": "Address must not be the zero/default pubkey"
    }
  ],
  "types": [
    {
      "name": "Bond",
      "docs": [
        "A founder's bond on a pump.fun coin. PDA seeds = [Bond::SEED, mint]; the",
        "collateral itself sits in a separate system-owned PDA,",
        "[Bond::VAULT_SEED, bond], so it can act as the `user` of a pump.fun buy.",
        "",
        "Target and collateral are lamports: pump.fun curves are SOL-quoted, and",
        "market cap is read straight from the pump.fun curve account, never from",
        "any oracle or off-chain input."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "founder",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "target_mcap",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "BondStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vault_bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "BondBurned",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "founder",
            "type": "pubkey"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "tokens_burned",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "BondClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "founder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "BondCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "founder",
            "type": "pubkey"
          },
          {
            "name": "target_mcap",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          },
          {
            "name": "deadline",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "BondRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "founder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "BondStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Active"
          },
          {
            "name": "Claimed"
          },
          {
            "name": "Burned"
          },
          {
            "name": "Refunded"
          }
        ]
      }
    },
    {
      "name": "Config",
      "docs": [
        "Global settings. PDA seeds = [Config::SEED]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "resolver",
            "docs": [
              "The admin wallet: may trigger `resolve_bond` and rotate resolver/keeper.",
              "It can NOT touch",
              "collateral: a resolve can only move a bond's collateral into",
              "pump.fun to buy-and-burn the coin. What this authority controls is",
              "only *whether/when* an expired, unmet bond gets burned — if it never",
              "acts, founders can reclaim after `STUCK_GRACE_SECS` (`refund_stuck`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "keeper",
            "docs": [
              "A second wallet allowed ONLY to trigger `resolve_bond`, meant for the",
              "hot key of an automated keeper. It cannot change any setting, and a",
              "resolve can never move collateral anywhere but into the burn — so a",
              "leaked keeper key can only trigger burns that are due anyway."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "KeeperChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "old",
            "type": "pubkey"
          },
          {
            "name": "new",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "ResolverChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "old",
            "type": "pubkey"
          },
          {
            "name": "new",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
