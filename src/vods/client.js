import { USE_STATIC_ARCHIVE, VODS_API_BASE } from "../config/site";
import { findVodsStatic } from "../api/vodsApi";

let remoteClient;
const getRemoteClient = () => {
  if (!remoteClient) {
    remoteClient = Promise.all([import("@feathersjs/feathers"), import("@feathersjs/rest-client")])
      .then(([{ feathers }, { default: rest }]) => {
        const client = feathers();
        client.configure(rest(VODS_API_BASE).fetch(window.fetch.bind(window)));
        return client;
      }).catch((error) => { remoteClient = null; throw error; });
  }
  return remoteClient;
};

const vodsClient = {
  service: (serviceName) => ({
    find: async (options = {}) => {
      if (!USE_STATIC_ARCHIVE) return (await getRemoteClient()).service(serviceName).find(options);
      if (serviceName !== "vods") throw new Error(`Unsupported static service: ${serviceName}`);
      return findVodsStatic(options.query || {});
    },
  }),
};

export default vodsClient;
