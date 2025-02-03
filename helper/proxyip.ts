import tls from "tls";
import { Worker, isMainThread, parentPort, workerData } from "worker_threads";
import fs from "fs/promises";

const KV_PAIR_PROXY_FILE = "./kvProxyList.json";
const RAW_PROXY_LIST_FILE = "./rawProxyList.txt";
const PROXY_LIST_FILE = "./proxyList.txt";
const IP_RESOLVER_DOMAIN = "myip.shylook.workers.dev";
const IP_RESOLVER_PATH = "/";
const CONCURRENCY = 50;

async function sendRequest(host, path, proxy = null) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy ? proxy.host : host,
      port: proxy ? proxy.port : 443,
      servername: host,
    };

    const socket = tls.connect(options, () => {
      const request = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`;
      socket.write(request);
    });

    let responseBody = "";
    socket.on("data", (data) => (responseBody += data.toString()));
    socket.on("end", () => resolve(responseBody.split("\r\n\r\n")[1] || ""));
    socket.on("error", (error) => reject(error));
    socket.setTimeout(5000, () => {
      reject(new Error("Request timeout"));
      socket.end();
    });
  });
}

async function checkProxy(proxyAddress, proxyPort) {
  try {
    const proxyInfo = { host: proxyAddress, port: proxyPort };
    const [ipinfo, myip] = await Promise.allSettled([
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, proxyInfo),
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, null),
    ]);

    if (ipinfo.status === "fulfilled" && myip.status === "fulfilled") {
      const parsedIpInfo = JSON.parse(ipinfo.value);
      const parsedMyIp = JSON.parse(myip.value);
      
      if (parsedIpInfo.ip && parsedIpInfo.ip !== parsedMyIp.ip) {
        return {
          error: false,
          result: {
            proxy: proxyAddress,
            port: proxyPort,
            proxyip: true,
            country: parsedIpInfo.country,
            asOrganization: parsedIpInfo.asOrganization,
          },
        };
      }
    }
  } catch (error) {
    return { error: true, message: error.message };
  }
  return { error: true, message: "Proxy test failed" };
}

async function readProxyList() {
  const proxyList = (await fs.readFile(RAW_PROXY_LIST_FILE, "utf-8")).split("\n");
  return proxyList.map((proxy) => {
    const [address, port, country, org] = proxy.split(",");
    return { address, port: parseInt(port), country, org };
  });
}

if (isMainThread) {
  (async () => {
    const proxyList = await readProxyList();
    const activeProxyList = [];
    const kvPair = {};

    console.log(`Checking ${proxyList.length} proxies...`);

    const workerPromises = proxyList.map((proxy) => {
      return new Promise((resolve) => {
        const worker = new Worker(__filename, { workerData: proxy });
        worker.on("message", (result) => {
          if (!result.error) {
            activeProxyList.push(
              `${result.result.proxy},${result.result.port},${result.result.country},${result.result.asOrganization}`
            );
            kvPair[result.result.country] = kvPair[result.result.country] || [];
            if (kvPair[result.result.country].length < 10) {
              kvPair[result.result.country].push(`${result.result.proxy}:${result.result.port}`);
            }
          }
          resolve();
        });
        worker.on("error", () => resolve());
      });
    });

    await Promise.all(workerPromises);
    await fs.writeFile(KV_PAIR_PROXY_FILE, JSON.stringify(kvPair, null, 2));
    await fs.writeFile(PROXY_LIST_FILE, activeProxyList.join("\n"));

    console.log("Proxy checking completed!");
    process.exit(0);
  })();
} else {
  checkProxy(workerData.address, workerData.port).then((result) => {
    parentPort.postMessage(result);
  });
}
