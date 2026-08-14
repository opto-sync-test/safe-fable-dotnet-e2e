module SafeFable.Client

open Browser.Dom
open Fable.Core
open Fable.Core.JsInterop

[<Emit("void navigator.serviceWorker?.register('/service-worker.js')")>]
let private registerServiceWorker (): unit = jsNative

[<Emit("navigator.serviceWorker?.controller?.postMessage($0)")>]
let private postToWorker (message: obj): unit = jsNative

[<Emit("window.addEventListener('online', () => navigator.serviceWorker?.controller?.postMessage({ type: 'drain' }))")>]
let private wakeWorkerWhenOnline (): unit = jsNative

let private queue lane recordId title updatedAt =
    createObj
        [ "type" ==> "enqueue"
          "lane" ==> lane
          "recordId" ==> recordId
          "baseJson" ==> "{}"
          "incomingJson"
          ==> (createObj
                   [ "id" ==> recordId
                     "title" ==> title
                     "updatedAt" ==> updatedAt ]
               |> JS.JSON.stringify) ]
    |> postToWorker

registerServiceWorker ()
wakeWorkerWhenOnline ()

let status = document.getElementById "status"

if not (isNull status) then
    status.textContent <- "Fable registered the durable OptoSync service worker."

queue "web-primary" "safe-web-1" "offline Fable edit" "2026-08-14T10:00:00Z"
queue "web-attachments" "safe-web-2" "multiplexed lane" "2026-08-14T10:00:01Z"
