#!/usr/bin/env bash
export NODE_OPTIONS=--openssl-legacy-provider

if ! npx tsc ; then
    exit
fi

node dist/index.js
