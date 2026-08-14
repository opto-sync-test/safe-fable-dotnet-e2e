module SafeFable.Server

open System
open System.Collections.Concurrent
open System.IO
open System.Text.Json
open System.Threading.Tasks
open Giraffe
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Http
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Hosting
open OptoSync.FSharp

type private WorkItem =
    { Lane: string
      BaseJson: string
      IncomingJson: string }

let private documents = ConcurrentDictionary<string, string>()

let private requiredString (root: JsonElement) (propertyName: string): string =
    match root.TryGetProperty propertyName with
    | true, value when value.ValueKind = JsonValueKind.String -> value.GetString()
    | _ -> null
    |> Option.ofObj
    |> Option.defaultWith (fun () -> invalidArg propertyName "A non-empty JSON string is required.")

let private syncHandler: HttpHandler =
    fun next context ->
        task {
            use reader = new StreamReader(context.Request.Body)
            let! raw = reader.ReadToEndAsync()
            use request = JsonDocument.Parse(raw)
            let lane = requiredString request.RootElement "lane"
            let recordId = requiredString request.RootElement "recordId"
            let suppliedBase = requiredString request.RootElement "baseJson"
            let incoming = requiredString request.RootElement "incomingJson"
            let key = lane + ":" + recordId
            let current = documents.GetOrAdd(key, suppliedBase)
            let merged = Reconciliation.merge current incoming
            documents[key] <- merged

            return!
                json
                    {| lane = lane
                       recordId = recordId
                       mergedJson = merged |}
                    next
                    context
        }

let private appRoutes: HttpHandler =
    choose
        [ GET >=> route "/health" >=> json {| status = "ok"; runtime = "Giraffe + F#" |}
          POST >=> route "/sync" >=> syncHandler ]

let rec private replayAfterReconnect (attempt: int) (item: WorkItem): Async<string * string> =
    async {
        if attempt = 0 then
            do! Async.Sleep 10
            return! replayAfterReconnect 1 item
        else
            let merged = Reconciliation.merge item.BaseJson item.IncomingJson
            return item.Lane, merged
    }

let private titleFrom json =
    use document = JsonDocument.Parse(json: string)
    document.RootElement.GetProperty("title").GetString()

let private runBackgroundContract () =
    let batches =
        [ { Lane = "mobile"
            BaseJson = """{"id":"safe-mobile","title":"server","updatedAt":"2026-08-14T10:00:00Z"}"""
            IncomingJson = """{"id":"safe-mobile","title":"mobile","updatedAt":"2026-08-14T11:00:00Z"}""" }
          { Lane = "desktop"
            BaseJson = """{"id":"safe-desktop","title":"server","updatedAt":"2026-08-14T10:00:00Z"}"""
            IncomingJson = """{"id":"safe-desktop","title":"desktop","updatedAt":"2026-08-14T11:00:00Z"}""" } ]

    let results =
        batches
        |> List.map (replayAfterReconnect 0)
        |> Async.Parallel
        |> Async.RunSynchronously
        |> Map.ofArray

    if results.Count <> 2 || titleFrom results["mobile"] <> "mobile" || titleFrom results["desktop"] <> "desktop" then
        invalidOp "The F# background worker failed to replay both multiplexed lanes."

    printfn "SAFE/Fable background contract passed with syncer.c %s." (Reconciliation.nativeVersion ())

[<EntryPoint>]
let main args =
    if Array.contains "--self-test" args then
        runBackgroundContract ()
        0
    else
        let publicRoot = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "../../public"))
        let options = WebApplicationOptions(Args = args, WebRootPath = publicRoot)
        let builder = WebApplication.CreateBuilder(options)
        builder.Services.AddGiraffe() |> ignore
        let app = builder.Build()
        app.UseDefaultFiles() |> ignore
        app.UseStaticFiles() |> ignore
        app.UseGiraffe appRoutes
        app.Run()
        0
