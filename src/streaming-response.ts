/**
 * A value a host function can return to give the program a streaming, `Response`-like object (with `Headers`).
 * A live web `Response` a host function hands the program, whose body the host streams for the lifetime of the run.
 * The program sees a `Response`: `type`, `url`, `status`, `statusText`, `ok`, `redirected`, `headers`, a live
 * `bodyUsed`, `text()`, `json()`, `bytes()`, `arrayBuffer()`, `clone()`, and a `body` it can read with a reader
 * (with `closed`) or `for await`. `blob()`, `formData()` and the body's `tee`, `pipeTo` and `pipeThrough` throw a
 * TypeError: the runtime has no Blob, FormData or WritableStream.
 */
export class StreamingResponse {
  constructor(
    readonly response: Response,
    readonly redirected = response.redirected,
  ) {}
}
