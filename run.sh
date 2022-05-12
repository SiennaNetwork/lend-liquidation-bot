#!/usr/bin/env bash

if ! yarn run tsc ; then
    exit
fi

node dist/index.js
