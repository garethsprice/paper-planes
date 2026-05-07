.PHONY: install serve build preview clean

install:
	npm install

# Pick an unused TCP port and serve on all interfaces.
serve:
	@PORT=$$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()") && \
	echo ">>> serving on https://0.0.0.0:$$PORT  (reachable at https://<this-host>:$$PORT/, accept self-signed cert)" && \
	npx vite --host 0.0.0.0 --port $$PORT --strictPort

build:
	npx vite build

preview:
	npx vite preview --host 0.0.0.0

clean:
	rm -rf node_modules dist
