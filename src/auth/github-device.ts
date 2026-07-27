import { requestUrl } from "obsidian";
import {
  GITHUB_DEVICE_URL,
  GITHUB_TOKEN_URL,
} from "../constants";
import { DeviceFlowResponse } from "../types";

/**
 * Step 1: Request a device code from GitHub.
 * Returns the user_code to display and the device_code to poll with.
 */
export async function requestDeviceCode(clientId: string): Promise<DeviceFlowResponse> {
  const response = await requestUrl({
    url: GITHUB_DEVICE_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `client_id=${encodeURIComponent(clientId)}&scope=repo`,
    throw: false,
  });

  if (response.status !== 200) {
    throw new Error(`GitHub Device Flow failed: ${response.status}`);
  }

  return response.json as DeviceFlowResponse;
}

/**
 * Step 2: Poll GitHub until the user approves or the code expires.
 * Resolves with the access token on success.
 * Throws on expiry or denial.
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  onPollStart?: () => void
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  let currentInterval = intervalSeconds * 1000;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() > deadline) {
        reject(new Error("Device code expired. Please try connecting again."));
        return;
      }

      onPollStart?.();

      const response = await requestUrl({
        url: GITHUB_TOKEN_URL,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `client_id=${encodeURIComponent(clientId)}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
        throw: false,
      });

      const data = response.json as Record<string, string>;

      if (data.access_token) {
        resolve(data.access_token);
        return;
      }

      switch (data.error) {
        case "authorization_pending":
          setTimeout(poll, currentInterval);
          break;
        case "slow_down":
          currentInterval += 5000;
          setTimeout(poll, currentInterval);
          break;
        case "expired_token":
          reject(new Error("Code expired. Please reconnect."));
          break;
        case "access_denied":
          reject(new Error("Access denied. You cancelled the authorization."));
          break;
        default:
          reject(new Error(`Unknown error: ${data.error}`));
      }
    };

    setTimeout(poll, currentInterval);
  });
}
