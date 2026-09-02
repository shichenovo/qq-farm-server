import { workerData as n, parentPort as o } from "worker_threads";
import { Socket as s, createServer as a } from "net";
import { g as c, C as i } from "../conout-wiJ7YKRd.js";
const r = n.conoutPipeName, e = new s();
e.setEncoding("utf8");
e.connect(r, () => {
  if (a((t) => {
    e.pipe(t);
  }).listen(c(r)), !o)
    throw new Error("worker_threads parentPort is null");
  o.postMessage(i.READY);
});
