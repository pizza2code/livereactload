import {Server} from "ws"
import {log} from "./console"
import https from 'https';
import {readFileSync} from 'fs';

function logError(error) {
  if (error) {
    log(error)
  }
}

export function startServer({port, sslKey, sslCert, debug}) {
  if ((sslCert && !sslKey) || (!sslCert && sslKey)) {
    throw new Error('You need both a certificate AND key in order to use SSL');
  }

  let wss;
  if (sslCert && sslKey) {
    const key = readFileSync(sslKey, 'utf8');
    const cert = readFileSync(sslCert, 'utf8');
    const credentials = {key, cert};
    const server = https.createServer(credentials);
    server.listen(port);
    wss = new Server({server});
  } else {
    wss = new Server({port});
  }

	let bundling = {};
	let changes = {};
	let browserClients = [];

  log("Using port " + port + "...")

  const server = {
	  notifyBundling(bundleId) {
		if (browserClients.length) {
		  logDebug("Starting to bundle " + bundleId + "...")
		  bundling[bundleId] = true
	  	}	
	  },
    notifyReload(metadata, bundleId) {
      if (browserClients.length) {
		changes[bundleId] = metadata
		bundling[bundleId] = false
		logDebug("Finished bundling " + bundleId)
	
		if (none(bundling)) {
		  bundling = {};
		  log("Notifying clients of bundle changes")
		  browserClients.forEach(client => {
			client.send(JSON.stringify({
			  type: "change",
			  data: changes
			}), logError)
		  });
		  changes = {};
		}
		else {
		  logDebug("Waiting on other bundles...")
		}
	  }
    },
    notifyBundleError(error) {
      if (browserClients.length) {
        log("Notify clients about bundle error...")
		browserClients.forEach(client => {
		  client.send(JSON.stringify({
		    type: "bundle_error",
		    data: { error: error.toString() }
		  }), logError)
		})
      }
    }
  }

  wss.on("connection", client => {
	// receives messages from external bundling processes & from browser clients
	client.on("message", msg => {
		const parsedMsg = JSON.parse(msg);
		const {type, bundleId, data} = parsedMsg;
		switch (type) {
			case "browser":
				log("New client connected")
				browserClients.push(client)
				break;
			case "reload":
				server.notifyReload(data, bundleId);
				break;
			case "bundling":
				server.notifyBundling(bundleId);
				break;
			default:
				logError("Unexpected message: " + msg);
				break;
		}
	});

	client.on("close", () => {
		// remove disconnected browser clients
		browserClients = browserClients.filter((c) => {
			if (c === client) {
				log("Client disconnected");
				return false;
			}
			return true;
		});
	});
  })

	function none(obj) {
		if (obj) {
			for (const prop in obj) {
				if (obj.hasOwnProperty(prop) && obj[prop]) {
					return false
				}
			}
		}
		return true
	}

	function logDebug(msg) {
		if (debug) {
			log(msg);
		}
	}

  return server
}
