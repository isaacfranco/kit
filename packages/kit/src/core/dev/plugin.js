import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import colors from 'kleur';
import sirv from 'sirv';
import { installFetch } from '../../install-fetch.js';
import * as sync from '../sync/sync.js';
import { getRequest, setResponse } from '../../node.js';
import { SVELTE_KIT_ASSETS } from '../constants.js';
import { get_mime_lookup, get_runtime_path, resolve_entry } from '../utils.js';
import { coalesce_to_error } from '../../utils/error.js';
import { load_template } from '../config/index.js';
import { sequence } from '../../hooks.js';
import { posixify } from '../../utils/filesystem.js';

/**
 * @param {import('types').ValidatedConfig} config
 * @param {string} cwd
 * @returns {Promise<import('vite').Plugin>}
 */
export async function create_plugin(config, cwd) {
	const runtime = get_runtime_path(config);

	/** @type {import('types').Handle} */
	let amp;

	if (config.kit.amp) {
		process.env.VITE_SVELTEKIT_AMP = 'true';
		amp = (await import('./amp_hook.js')).handle;
	}

	process.env.VITE_SVELTEKIT_APP_VERSION_POLL_INTERVAL = '0';

	/** @type {import('types').Respond} */
	const respond = (await import(`${runtime}/server/index.js`)).respond;

	return {
		name: 'vite-plugin-svelte-kit',

		configureServer(vite) {
			installFetch();

			/** @type {import('types').SSRManifest} */
			let manifest;

			function update_manifest() {
				const { manifest_data } = sync.update(config);

				manifest = {
					appDir: config.kit.appDir,
					assets: new Set(manifest_data.assets.map((asset) => asset.file)),
					_: {
						mime: get_mime_lookup(manifest_data),
						entry: {
							file: `/@fs${runtime}/client/start.js`,
							css: [],
							js: []
						},
						nodes: manifest_data.components.map((id) => {
							return async () => {
								const url = id.startsWith('..') ? `/@fs${path.posix.resolve(id)}` : `/${id}`;

								const module = /** @type {import('types').SSRComponent} */ (
									await vite.ssrLoadModule(url)
								);
								const node = await vite.moduleGraph.getModuleByUrl(url);

								if (!node) throw new Error(`Could not find node for ${url}`);

								const deps = new Set();
								find_deps(node, deps);

								/** @type {Record<string, string>} */
								const styles = {};

								for (const dep of deps) {
									const parsed = new URL(dep.url, 'http://localhost/');
									const query = parsed.searchParams;

									// TODO what about .scss files, etc?
									if (
										dep.file.endsWith('.css') ||
										(query.has('svelte') && query.get('type') === 'style')
									) {
										try {
											const mod = await vite.ssrLoadModule(dep.url);
											styles[dep.url] = mod.default;
										} catch {
											// this can happen with dynamically imported modules, I think
											// because the Vite module graph doesn't distinguish between
											// static and dynamic imports? TODO investigate, submit fix
										}
									}
								}

								return {
									module,
									entry: url.endsWith('.svelte') ? url : url + '?import',
									css: [],
									js: [],
									// in dev we inline all styles to avoid FOUC
									styles
								};
							};
						}),
						routes: manifest_data.routes.map((route) => {
							if (route.type === 'page') {
								return {
									type: 'page',
									key: route.key,
									pattern: route.pattern,
									params: get_params(route.params),
									shadow: route.shadow
										? async () => {
												const url = path.resolve(cwd, /** @type {string} */ (route.shadow));
												return await vite.ssrLoadModule(url);
										  }
										: null,
									a: route.a.map((id) => manifest_data.components.indexOf(id)),
									b: route.b.map((id) => manifest_data.components.indexOf(id))
								};
							}

							return {
								type: 'endpoint',
								pattern: route.pattern,
								params: get_params(route.params),
								load: async () => {
									const url = path.resolve(cwd, route.file);
									return await vite.ssrLoadModule(url);
								}
							};
						})
					}
				};
			}

			/** @param {Error} error */
			function fix_stack_trace(error) {
				// TODO https://github.com/vitejs/vite/issues/7045

				// ideally vite would expose ssrRewriteStacktrace, but
				// in lieu of that, we can implement it ourselves. we
				// don't want to mutate the error object, because
				// the stack trace could be 'fixed' multiple times,
				// and Vite will fix stack traces before we even
				// see them if they occur during ssrLoadModule
				const original = error.stack;
				vite.ssrFixStacktrace(error);
				const fixed = error.stack;
				error.stack = original;

				return fixed;
			}

			update_manifest();

			vite.watcher.on('add', update_manifest);
			vite.watcher.on('remove', update_manifest);

			const assets = config.kit.paths.assets ? SVELTE_KIT_ASSETS : config.kit.paths.base;
			const asset_server = sirv(config.kit.files.assets, {
				dev: true,
				etag: true,
				maxAge: 0,
				extensions: []
			});

			return () => {
				remove_html_middlewares(vite.middlewares);

				vite.middlewares.use(async (req, res) => {
					try {
						if (!req.url || !req.method) throw new Error('Incomplete request');

						const base = `${vite.config.server.https ? 'https' : 'http'}://${req.headers.host}`;

						const decoded = decodeURI(new URL(base + req.url).pathname);

						if (decoded.startsWith(assets)) {
							const pathname = decoded.slice(assets.length);
							const file = config.kit.files.assets + pathname;

							if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
								req.url = encodeURI(pathname); // don't need query/hash
								asset_server(req, res);
								return;
							}
						}

						if (req.url === '/favicon.ico') return not_found(res);

						if (!decoded.startsWith(config.kit.paths.base)) return not_found(res);

						/** @type {Partial<import('types').Hooks>} */
						const user_hooks = resolve_entry(config.kit.files.hooks)
							? await vite.ssrLoadModule(`/${config.kit.files.hooks}`)
							: {};

						const handle = user_hooks.handle || (({ event, resolve }) => resolve(event));

						/** @type {import('types').Hooks} */
						const hooks = {
							getSession: user_hooks.getSession || (() => ({})),
							handle: amp ? sequence(amp, handle) : handle,
							handleError:
								user_hooks.handleError ||
								(({ /** @type {Error & { frame?: string }} */ error }) => {
									console.error(colors.bold().red(error.message));
									if (error.frame) {
										console.error(colors.gray(error.frame));
									}
									if (error.stack) {
										console.error(colors.gray(error.stack));
									}
								}),
							externalFetch: user_hooks.externalFetch || fetch
						};

						if (/** @type {any} */ (hooks).getContext) {
							// TODO remove this for 1.0
							throw new Error(
								'The getContext hook has been removed. See https://kit.svelte.dev/docs/hooks'
							);
						}

						if (/** @type {any} */ (hooks).serverFetch) {
							// TODO remove this for 1.0
							throw new Error('The serverFetch hook has been renamed to externalFetch.');
						}

						// TODO the / prefix will probably fail if outDir is outside the cwd (which
						// could be the case in a monorepo setup), but without it these modules
						// can get loaded twice via different URLs, which causes failures. Might
						// require changes to Vite to fix
						const { default: root } = await vite.ssrLoadModule(
							`/${posixify(path.relative(cwd, `${config.kit.outDir}/generated/root.svelte`))}`
						);

						const paths = await vite.ssrLoadModule(
							process.env.BUNDLED
								? `/${posixify(path.relative(cwd, `${config.kit.outDir}/runtime/paths.js`))}`
								: `/@fs${runtime}/paths.js`
						);

						paths.set_paths({
							base: config.kit.paths.base,
							assets
						});

						let request;

						try {
							request = await getRequest(base, req);
						} catch (/** @type {any} */ err) {
							res.statusCode = err.status || 400;
							return res.end(err.reason || 'Invalid request body');
						}

						const template = load_template(cwd, config);

						const rendered = await respond(request, {
							amp: config.kit.amp,
							csp: config.kit.csp,
							dev: true,
							floc: config.kit.floc,
							get_stack: (error) => {
								return fix_stack_trace(error);
							},
							handle_error: (error, event) => {
								hooks.handleError({
									error: new Proxy(error, {
										get: (target, property) => {
											if (property === 'stack') {
												return fix_stack_trace(error);
											}

											return Reflect.get(target, property, target);
										}
									}),
									event,

									// TODO remove for 1.0
									// @ts-expect-error
									get request() {
										throw new Error(
											'request in handleError has been replaced with event. See https://github.com/sveltejs/kit/pull/3384 for details'
										);
									}
								});
							},
							hooks,
							hydrate: config.kit.browser.hydrate,
							manifest,
							method_override: config.kit.methodOverride,
							paths: {
								base: config.kit.paths.base,
								assets
							},
							prefix: '',
							prerender: config.kit.prerender.enabled,
							read: (file) => fs.readFileSync(path.join(config.kit.files.assets, file)),
							root,
							router: config.kit.browser.router,
							template: ({ head, body, assets, nonce }) => {
								return (
									template
										.replace(/%svelte\.assets%/g, assets)
										.replace(/%svelte\.nonce%/g, nonce)
										// head and body must be replaced last, in case someone tries to sneak in %svelte.assets% etc
										.replace('%svelte.head%', () => head)
										.replace('%svelte.body%', () => body)
								);
							},
							template_contains_nonce: template.includes('%svelte.nonce%'),
							trailing_slash: config.kit.trailingSlash
						});

						if (rendered) {
							setResponse(res, rendered);
						} else {
							not_found(res);
						}
					} catch (e) {
						const error = coalesce_to_error(e);
						vite.ssrFixStacktrace(error);
						res.statusCode = 500;
						res.end(error.stack);
					}
				});
			};
		}
	};
}

/** @param {string[]} array */
function get_params(array) {
	// given an array of params like `['x', 'y', 'z']` for
	// src/routes/[x]/[y]/[z]/svelte, create a function
	// that turns a RegExpExecArray into ({ x, y, z })

	/** @param {RegExpExecArray} match */
	const fn = (match) => {
		/** @type {Record<string, string>} */
		const params = {};
		array.forEach((key, i) => {
			if (key.startsWith('...')) {
				params[key.slice(3)] = match[i + 1] || '';
			} else {
				params[key] = match[i + 1];
			}
		});
		return params;
	};

	return fn;
}

/** @param {import('http').ServerResponse} res */
function not_found(res) {
	res.statusCode = 404;
	res.end('Not found');
}

/**
 * @param {import('connect').Server} server
 */
function remove_html_middlewares(server) {
	const html_middlewares = [
		'viteIndexHtmlMiddleware',
		'vite404Middleware',
		'viteSpaFallbackMiddleware'
	];
	for (let i = server.stack.length - 1; i > 0; i--) {
		// @ts-expect-error using internals until https://github.com/vitejs/vite/pull/4640 is merged
		if (html_middlewares.includes(server.stack[i].handle.name)) {
			server.stack.splice(i, 1);
		}
	}
}

/**
 * @param {import('vite').ModuleNode} node
 * @param {Set<import('vite').ModuleNode>} deps
 */
function find_deps(node, deps) {
	for (const dep of node.importedModules) {
		if (!deps.has(dep)) {
			deps.add(dep);
			find_deps(dep, deps);
		}
	}
}
