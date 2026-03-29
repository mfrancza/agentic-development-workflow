#!/bin/bash
# GIT_ASKPASS helper — provides credentials without writing them to disk.
# Git calls this script with a prompt; we return the appropriate value.
case "$1" in
    *Username*) echo "x-access-token" ;;
    *Password*) echo "$GH_TOKEN" ;;
esac
