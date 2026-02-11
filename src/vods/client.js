import { feathers } from "@feathersjs/feathers";
import rest from "@feathersjs/rest-client";
import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";
import { findVodsStatic } from "../api/vodsApi";

let vodsClient = feathers();

if (USE_STATIC_ARCHIVE) {
  vodsClient = {
    service: (serviceName) => ({
      find: ({ query } = {}) => {
        if (serviceName !== "vods") {
          return Promise.reject(new Error(`Unsupported static service: ${serviceName}`));
        }
        return findVodsStatic(query || {});
      },
    }),
  };
} else {
  const restClient = rest(VODS_API_BASE);
  vodsClient.configure(restClient.fetch(window.fetch.bind(window)));
}

export default vodsClient;
