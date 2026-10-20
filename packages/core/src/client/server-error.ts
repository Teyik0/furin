/**
 * Wire form of a server-side route failure: the public message, the HTTP
 * status and the digest logged on the server. Carried by a failed route match.
 */
export interface FurinServerErrorPayload {
  digest: string;
  message: string;
  status: number;
}
