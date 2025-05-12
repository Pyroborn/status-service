#!/bin/bash

# Script to switch between local and Kubernetes environments

ENV_TYPE=$1

if [ "$ENV_TYPE" == "local" ]; then
    echo "Switching to local environment..."
    cp .env.local .env
    echo "Environment switched to local mode."
    echo "Use 'npm run dev' to start the service locally."
elif [ "$ENV_TYPE" == "k8s" ] || [ "$ENV_TYPE" == "kubernetes" ]; then
    echo "Switching to Kubernetes environment..."
    cp .env.kubernetes .env
    echo "Environment switched to Kubernetes mode."
    echo "Use 'npm start' to start the service for Kubernetes."
else
    echo "Usage: ./switch-env.sh [local|k8s|kubernetes]"
    echo "  local      - Switch to local development environment"
    echo "  k8s        - Switch to Kubernetes environment"
    echo "  kubernetes - Switch to Kubernetes environment"
    exit 1
fi

exit 0 