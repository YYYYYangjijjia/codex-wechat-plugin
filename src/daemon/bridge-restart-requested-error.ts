export class BridgeRestartRequestedError extends Error {
  public constructor(message = "Bridge restart requested.") {
    super(message);
    this.name = "BridgeRestartRequestedError";
  }
}
