# SillyTavern Character Tools (server plugin) — dev tasks.
# The plugin runs from the committed dist/plugin.js bundle (no build on install),
# so `verify-dist` guards that the bundle matches source.

.DEFAULT_GOAL := help
.PHONY: help install lint lint-fix typecheck test build verify-dist check clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (reproducible, from package-lock.json)
	npm ci

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with --fix
	npm run lint:fix

typecheck: ## Type-check with tsc (no emit)
	npm run typecheck

test: ## Run the unit tests once
	npm test

build: ## Build the production dist/plugin.js bundle
	npm run build

verify-dist: ## Rebuild and fail if the committed dist/ is stale
	npm run verify:dist

check: lint typecheck test ## Full local gate: lint + typecheck + tests (what CI runs)

clean: ## Remove installed dependencies and coverage output
	rm -rf node_modules coverage
