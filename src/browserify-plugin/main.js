import _ from "lodash"
import umd from "umd"
import through from "through2"
import md5 from "md5"
import WebSocket from "ws"
import {readFileSync} from "fs"
import {resolve} from "path"
import convertSourceMaps from 'convert-source-map'
import offsetSourceMaps from 'offset-sourcemap-lines'
import {startServer} from "./server"
import {log} from "./console"
import loader from "../reloading"

const entries = [];
const servers = [];

function LiveReactloadPlugin(b, opts = {}) {

  const {
	  port = 4474,
	  host = null,
	  client = true,
	  dedupe = true,
	  debug = false,
	  basedir = process.cwd(),
	  'ssl-cert': sslCert = null,
	  'ssl-key': sslKey = null,
  } = opts

	let server = null;
	if (opts.server !== false) {
	  const duplicates = servers.filter(server =>
		  server.port == port && server.host == host
	  );
		if (duplicates.length == 0) {
		  // server is alive as long as watchify is running
			server = (opts.server !== false) ? 
				startServer({port: Number(port), sslCert, sslKey}) : null;
			servers.push({port, host, server});
		}
		else {
			server = duplicates[0].server;
		}
	}

  const clientOpts = {
    // assuming that livereload package is in global mdule directory (node_modules)
    // and this file is in ./lib/babel-plugin folder
    nodeModulesRoot: resolve(__dirname, "../../.."),
    port: Number(port),
    host: host,
    clientEnabled: client,
    debug: debug,
	  externalEntries: opts.externalEntries,
	  bundleId: opts.bundleId
  }

	b.on("reset", addHooks)
  addHooks()

  function addHooks() {
    // this cache object is preserved over single bundling
    // pipeline so when next bundling occurs, this cache
    // object is thrown away
    const mappings = {}, pathById = {}, pathByIdx = {}
	const dedupe = opts.dedupe;

    const idToPath = id =>
      pathById[id] || (_.isString(id) && id) || throws("Full path not found for id: " + id)

    const idxToPath = idx =>
      pathByIdx[idx] || (_.isString(idx) && idx) || throws("Full path not found for index: " + idx)

	let standalone = null
	let hasExports = null

	if (server) {
	  b.pipeline.on("error", server.notifyBundleError)
		server.notifyBundling(opts.bundleId);
	}
	  else if (opts.externalEntries) {
		  // notify server a bundle is starting to build
		  const ws = new WebSocket(`ws://localhost:${port}`);
		  ws.on('open', () => {
			  ws.send(JSON.stringify({
				  type: "bundling", 
				  data: null, 
				  bundleId: opts.bundleId 
			  }), () =>
				  ws.close()
			  );
		  });
	  }

	b.pipeline.get("record").push(through.obj(
	  function transform(row, enc, next) {
		const s = _.get(row, "options._flags.standalone")
		if (s) {
		  standalone = s
		}
		  if (row.expose) {
			  hasExports = true;
			  if (debug) {
				console.log(`${file} exposed as '${row.expose}'`);
			  }
		  }
		next(null, row)
	  }
	))

	b.pipeline.get("sort").push(through.obj(
	  function transform(row, enc, next) {
		const {id, index, file} = row
		pathById[id] = file
		pathByIdx[index] = file
		next(null, row)
	  }
	))

	if (!dedupe) {
	  b.pipeline.splice("dedupe", 1, through.obj())
	  if (b.pipeline.get("dedupe")) {
		log("Other plugins have added de-duplicate transformations. --no-dedupe is not effective")
	  }
	} else {
	  b.pipeline.splice("dedupe", 0, through.obj(
		function transform(row, enc, next) {
		  const cloned = _.extend({}, row)
		  if (row.dedupeIndex) {
			cloned.dedupeIndex = idxToPath(row.dedupeIndex)
		  }
		  if (row.dedupe) {
			cloned.dedupe = idToPath(row.dedupe)
		  }
		  next(null, cloned)
		}
	  ))
	}

	b.pipeline.get("label").push(through.obj(
	  function transform(row, enc, next) {
		const {id, file, source, deps, entry} = row
		const converter = convertSourceMaps.fromSource(source)
		let sourceWithoutMaps = source
		let adjustedSourcemap = ''
		let hash;

		if (converter) {
		  sourceWithoutMaps = convertSourceMaps.removeComments(source)
		  hash = md5(sourceWithoutMaps)
		  adjustedSourcemap = convertSourceMaps.fromObject(offsetSourceMaps(converter.toObject(), 1)).toComment()
		} else {
		  hash = md5(source)
		}

		  if (row.expose != undefined) {
		  }

		if (entry) {
			// TODO support multiple entries
			entries.length = 0;
			entries.push(file);
		}
		mappings[file] = [sourceWithoutMaps, deps, {id: file, hash: hash, browserifyId: id, sourcemap: adjustedSourcemap}]
		next(null, row)
	  },
	  function flush(next) {
		next()
	  }
	))

	b.pipeline.get("wrap").push(through.obj(
	  function transform(row, enc, next) {
		next(null)
	  },
	  function flush(next) {
		const pathById = _.fromPairs(_.toPairs(mappings).map(([file, [s, d, {browserifyId: id}]]) => [id, file]))
		const idToPath = id =>
		  pathById[id] || (_.isString(id) && id)

		const depsToPaths = deps =>
		  _.reduce(deps, (m, v, k) => {
			let id = idToPath(v);
			if (id) {
			  m[k] = id;
			}
			return m;
		  }, {})

		const withFixedDepsIds = _.mapValues(mappings, ([src, deps, meta]) => [
		  src,
		  depsToPaths(deps),
		  meta
		])
		const args = [
		  withFixedDepsIds,
		  entries,
		  clientOpts
		]
		let bundleSrc =
		  `(${loader.toString()})(${args.map(a => JSON.stringify(a, null, 2)).join(", ")})`
		if (hasExports) {
			bundleSrc = `__livereactload_export = ${bundleSrc};\n` +
				`require = __livereactload_export.load;`;
		}
		bundleSrc = `${bundleSrc};`
		if (standalone) {
		  bundleSrc = umd(standalone, `return ${bundleSrc}`)
		}

		this.push(new Buffer(bundleSrc, "utf8"))
		if (server) {
		  server.notifyReload(withFixedDepsIds, opts.bundleId)
		}
		  else if (opts.externalEntries) {
			  // notify server of reload
			  const ws = new WebSocket(`ws://localhost:${port}`);
			  ws.on('open', () => {
				  ws.send(JSON.stringify({
					  type: "reload", 
					  data: withFixedDepsIds, 
					  bundleId: opts.bundleId 
				  }), () =>
					  ws.close()
				  );
			  });
		  }
		next()
	  }
	))
  }

  function throws(msg) {
    throw new Error(msg)
  }
}

module.exports = LiveReactloadPlugin
