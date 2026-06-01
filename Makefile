.PHONY: setup start

ifeq ($(OS),Windows_NT)
setup:
	scripts\setup.bat

start:
	scripts\start.bat
else
setup:
	bash scripts/setup.sh

start:
	./scripts/start.sh
endif
