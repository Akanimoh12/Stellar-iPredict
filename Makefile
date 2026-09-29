# ─────────────────────────────────────────────────────────────────────────────
# iPredict — local task runner (issue #208)
#
#   make            list every target
#   make up         Postgres + Redis
#   make migrate    apply db/migrations
#   make seed       load local sample data
#   make test       every suite
#
# Why make and not just: make is already on every machine that has Xcode CLT,
# build-essential, or Git for Windows, so `make up` works on a fresh checkout
# with nothing installed. A second runner would only be a second place for the
# commands to drift out of date — this file is the one place they live.
#
# Everything is overridable from the command line:
#
#   make up ENV=staging
#   make migrate DATABASE_URL=postgres://user:pass@host:5432/db
#   make logs SERVICE=redis
#
# Nothing here needs a secret. `make up` starts the dev stack, whose Postgres
# and Redis credentials are the fixed local ones in docker-compose.dev.yml.
# For the container stack see infra/README.md, and for where secrets come from
# see docs/SECRETS.md.
# ─────────────────────────────────────────────────────────────────────────────

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# ── Configuration ────────────────────────────────────────────────────────────

# dev | staging | production. Selects infra/docker-compose.$(ENV).yml.
ENV ?= dev
COMPOSE ?= docker compose
COMPOSE_FILE ?= infra/docker-compose.$(ENV).yml
MONITORING_FILE ?= infra/docker-compose.monitoring.yml
DC := $(COMPOSE) -f $(COMPOSE_FILE)

# Matches the fixed local credentials in infra/docker-compose.dev.yml. Export
# DATABASE_URL in your shell, or pass it per-invocation, to point elsewhere.
DATABASE_URL ?= postgres://ipredict:ipredict@localhost:5432/ipredict
export DATABASE_URL

REDIS_URL ?= redis://localhost:6379
export REDIS_URL

NPM ?= npm

# Ports the /metrics targets listen on. The indexer default is 9091 rather
# than its code default of 9090, which collides with the Prometheus container's
# published port (see indexer/.env.example).
API_PORT ?= 4000
INDEXER_METRICS_PORT ?= 9091
ORACLE_METRICS_PORT ?= 9101

# Optional: `make logs SERVICE=redis` narrows to one service.
SERVICE ?=

.PHONY: help install env up down restart ps logs wait \
        migrate migrate-down seed db-shell db-reset \
        dev-backend dev-indexer dev-oracle dev-monitor dev-frontend \
        build typecheck test test-shared test-backend test-indexer test-oracle \
        test-db test-frontend test-contracts verify \
        monitoring-up monitoring-down metrics promtool \
        secrets-check secrets-scaffold clean

# ─────────────────────────────────────────────────────────────────────────────
##@ General

help: ## List every target
	@awk 'BEGIN { \
		FS = ":.*##"; \
		printf "\niPredict task runner\n\nUsage:\n  make \033[36m<target>\033[0m [VAR=value]\n"; \
	} \
	/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 } \
	/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } \
	END { printf "\nVariables: ENV=%s DATABASE_URL=<set> COMPOSE=%s\n\n", "$(ENV)", "$(COMPOSE)" }' \
	$(MAKEFILE_LIST)

# ─────────────────────────────────────────────────────────────────────────────
##@ Setup

install: ## Install dependencies for the workspaces, db, and frontend
	$(NPM) install
	cd db && $(NPM) install
	cd frontend && $(NPM) install

env: ## Create any missing .env files from their .env.example
	@set -e; \
	for pair in \
		"backend/.env.example:backend/.env" \
		"indexer/.env.example:indexer/.env" \
		"oracle/.env.example:oracle/.env" \
		"frontend/.env.local.example:frontend/.env.local"; do \
		src="$${pair%%:*}"; dst="$${pair##*:}"; \
		if [ -f "$$dst" ]; then \
			echo "  exists  $$dst"; \
		else \
			cp "$$src" "$$dst"; echo "  created $$dst"; \
		fi; \
	done; \
	echo; \
	echo "Fill in the blanks before running a service. Never commit these files."

# ─────────────────────────────────────────────────────────────────────────────
##@ Infrastructure

up: ## Start Postgres + Redis (ENV=staging|production for the full stack)
	$(DC) up -d --wait
	@$(MAKE) --no-print-directory ps

down: ## Stop the stack, keeping volumes
	$(DC) down

restart: ## Recreate the stack
	$(DC) up -d --force-recreate --wait

ps: ## Show container status
	$(DC) ps

logs: ## Follow logs (SERVICE=redis to narrow)
	$(DC) logs -f $(SERVICE)

wait: ## Block until Postgres accepts connections
	@echo "Waiting for Postgres at $$DATABASE_URL ..."
	@for i in $$(seq 1 60); do \
		if $(DC) exec -T postgres pg_isready -q 2>/dev/null; then echo "ready"; exit 0; fi; \
		sleep 1; \
	done; \
	echo "Postgres did not become ready in 60s. Try: make logs SERVICE=postgres" >&2; \
	exit 1

# ─────────────────────────────────────────────────────────────────────────────
##@ Database

migrate: ## Apply every pending migration in db/migrations
	cd db && $(NPM) run migrate

migrate-down: ## Roll back the most recent migration
	cd db && $(NPM) run migrate:down

seed: ## Load local sample markets, bets, and leaderboard rows
	cd db && $(NPM) run seed

db-shell: ## Open psql against the running dev database
	$(DC) exec postgres psql -U ipredict -d ipredict

db-reset: ## Destroy the database volume, then recreate, migrate, and seed
	@echo "This deletes the '$(ENV)' Postgres and Redis volumes."
	@read -r -p "Type 'reset' to continue: " reply; [ "$$reply" = "reset" ] || { echo "aborted"; exit 1; }
	$(DC) down -v
	$(MAKE) --no-print-directory up
	$(MAKE) --no-print-directory migrate
	$(MAKE) --no-print-directory seed

# ─────────────────────────────────────────────────────────────────────────────
##@ Development

dev-backend: ## Run the API on the host
	cd backend && $(NPM) run dev

dev-indexer: ## Run the indexer on the host
	cd indexer && METRICS_PORT=$(INDEXER_METRICS_PORT) $(NPM) run dev

dev-oracle: ## Run the oracle aggregator on the host
	cd oracle && $(NPM) run dev

dev-monitor: ## Run the read-only oracle monitor on the host
	cd oracle && $(NPM) run dev:monitor

dev-frontend: ## Run the Next.js app
	cd frontend && $(NPM) run dev

# ─────────────────────────────────────────────────────────────────────────────
##@ Quality

build: ## Build every workspace
	$(NPM) run build

typecheck: ## Typecheck every workspace
	$(NPM) run typecheck

test: test-shared test-backend test-indexer test-oracle test-db ## Run every Node suite

test-shared: ## @ipredict/shared (node:test)
	$(NPM) test --workspace=@ipredict/shared

test-backend: ## Backend API suite
	cd backend && $(NPM) test

test-indexer: ## Indexer suite
	cd indexer && $(NPM) test

test-oracle: ## Oracle suite
	cd oracle && $(NPM) test

test-db: ## Migration and seed suite (needs a running Postgres)
	cd db && $(NPM) test

test-frontend: ## Frontend suite
	cd frontend && $(NPM) test

test-contracts: ## Soroban contract suite
	cd contracts && cargo test --workspace

verify: typecheck test ## Typecheck, then run every Node suite

# ─────────────────────────────────────────────────────────────────────────────
##@ Observability

monitoring-up: ## Start Prometheus + Grafana
	$(COMPOSE) -f $(MONITORING_FILE) up -d
	@echo "Prometheus http://localhost:9090/targets  Grafana http://localhost:3000"

monitoring-down: ## Stop Prometheus + Grafana
	$(COMPOSE) -f $(MONITORING_FILE) down

metrics: ## Curl every /metrics endpoint and report which ones answer
	@set +e; \
	for target in \
		"backend:$(API_PORT)" \
		"indexer:$(INDEXER_METRICS_PORT)" \
		"oracle:$(ORACLE_METRICS_PORT)"; do \
		name="$${target%%:*}"; port="$${target##*:}"; \
		body=$$(curl -fsS --max-time 3 "http://localhost:$$port/metrics" 2>/dev/null); \
		if [ -n "$$body" ]; then \
			printf "  %-8s :%s  %s series\n" "$$name" "$$port" "$$(printf '%s\n' "$$body" | grep -cv '^#')"; \
		else \
			printf "  %-8s :%s  not running\n" "$$name" "$$port"; \
		fi; \
	done

promtool: ## Validate the Prometheus config and alert rules
	promtool check config infra/prometheus/prometheus.yml
	promtool check rules infra/prometheus/alerts.yml

# ─────────────────────────────────────────────────────────────────────────────
##@ Secrets

secrets-check: ## Fail if any .env file is tracked by git, and list untracked ones
	@tracked=$$(git ls-files | grep -E '(^|/)\.env($$|\.)' | grep -v '\.example$$' || true); \
	if [ -n "$$tracked" ]; then \
		echo "Secret files are tracked by git:" >&2; \
		echo "$$tracked" >&2; \
		echo "Remove them with 'git rm --cached <file>' and rotate every value they held." >&2; \
		exit 1; \
	fi; \
	echo "No .env file is tracked."; \
	found=$$(find . -name '.env' -not -path './node_modules/*' -not -path './*/node_modules/*' 2>/dev/null || true); \
	if [ -n "$$found" ]; then \
		echo "Local (git-ignored) secret files:"; \
		echo "$$found" | while read -r f; do printf "  %s  mode %s\n" "$$f" "$$(stat -c '%a' "$$f" 2>/dev/null || stat -f '%Lp' "$$f")"; done; \
		echo "chmod 600 anything holding a signing key."; \
	fi

secrets-scaffold: ## Create infra/.env from infra/.env.example for the container stack
	@if [ -f infra/.env ]; then \
		echo "infra/.env already exists — not overwriting."; \
	else \
		cp infra/.env.example infra/.env; chmod 600 infra/.env; \
		echo "Created infra/.env (mode 600). Replace every CHANGE_ME value."; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
##@ Housekeeping

clean: ## Remove build output and coverage reports
	rm -rf shared/dist backend/dist indexer/dist oracle/dist frontend/.next
	rm -rf backend/coverage indexer/coverage oracle/coverage frontend/coverage
	@echo "Removed build output. node_modules left alone — use 'make install' to refresh."
