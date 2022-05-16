#!/usr/bin/env bash

if ! yarn run tsc ; then
    exit
fi

node --experimental-fetch dist/index.js
