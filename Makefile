PROJECT_NAME := loamium

.PHONY: serve serve-ui stop test build lint verify clean

serve:
	@portman acquire --name $(PROJECT_NAME) --pid-file .server.pid -- \
		npm run dev --workspace packages/server

serve-ui:
	@portman acquire --name $(PROJECT_NAME)-ui --pid-file .ui.pid -- \
		npm run dev --workspace packages/ui

stop:
	@portman release --name $(PROJECT_NAME) --pid-file .server.pid || true
	@portman release --name $(PROJECT_NAME)-ui --pid-file .ui.pid || true

test:
	@mkdir -p reports
	npm test

verify: test

build:
	npm run build --workspaces --if-present

lint:
	npm run lint --workspaces --if-present
