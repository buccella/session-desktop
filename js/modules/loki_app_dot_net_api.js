/* global log, textsecure, libloki, Signal, Whisper,
clearTimeout, getMessageController, libsignal, StringView, window, _,
dcodeIO, Buffer, process */
const insecureNodeFetch = require('node-fetch');
const { URL, URLSearchParams } = require('url');
const FormData = require('form-data');
const https = require('https');
const path = require('path');
const DataMessage = require('../../ts/receiver/dataMessage');

// Can't be less than 1200 if we have unauth'd requests
const PUBLICCHAT_MSG_POLL_EVERY = 1.5 * 1000; // 1.5s
const PUBLICCHAT_CHAN_POLL_EVERY = 20 * 1000; // 20s
const PUBLICCHAT_DELETION_POLL_EVERY = 5 * 1000; // 5s
const PUBLICCHAT_MOD_POLL_EVERY = 30 * 1000; // 30s

// FIXME: replace with something on urlPubkeyMap...
const FILESERVER_HOSTS = [
  'file-dev.lokinet.org',
  'file.lokinet.org',
  'file-dev.getsession.org',
  'file.getsession.org',
];

const LOKIFOUNDATION_DEVFILESERVER_PUBKEY =
  'BSZiMVxOco/b3sYfaeyiMWv/JnqokxGXkHoclEx8TmZ6';
const LOKIFOUNDATION_FILESERVER_PUBKEY =
  'BWJQnVm97sQE3Q1InB4Vuo+U/T1hmwHBv0ipkiv8tzEc';
const LOKIFOUNDATION_APNS_PUBKEY =
  'BWQqZYWRl0LlotTcUSRJZPvNi8qyt1YSQH3li4EHQNBJ';

const urlPubkeyMap = {
  'https://file-dev.getsession.org': LOKIFOUNDATION_DEVFILESERVER_PUBKEY,
  'https://file-dev.lokinet.org': LOKIFOUNDATION_DEVFILESERVER_PUBKEY,
  'https://file.getsession.org': LOKIFOUNDATION_FILESERVER_PUBKEY,
  'https://file.lokinet.org': LOKIFOUNDATION_FILESERVER_PUBKEY,
  'https://dev.apns.getsession.org': LOKIFOUNDATION_APNS_PUBKEY,
  'https://live.apns.getsession.org': LOKIFOUNDATION_APNS_PUBKEY,
};

const HOMESERVER_USER_ANNOTATION_TYPE = 'network.loki.messenger.homeserver';
const AVATAR_USER_ANNOTATION_TYPE = 'network.loki.messenger.avatar';
const SETTINGS_CHANNEL_ANNOTATION_TYPE = 'net.patter-app.settings';
const MESSAGE_ATTACHMENT_TYPE = 'net.app.core.oembed';
const LOKI_ATTACHMENT_TYPE = 'attachment';
const LOKI_PREVIEW_TYPE = 'preview';

const snodeHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const MAX_SEND_ONION_RETRIES = 3;

const sendViaOnion = async (srvPubKey, url, fetchOptions, options = {}) => {
  if (!srvPubKey) {
    log.error(
      'loki_app_dot_net:::sendViaOnion - called without a server public key'
    );
    return {};
  }

  // set retry count
  if (options.retry === undefined) {
    // eslint-disable-next-line no-param-reassign
    options.retry = 0;
    // eslint-disable-next-line no-param-reassign
    options.requestNumber = window.OnionPaths.getInstance().assignOnionRequestNumber();
  }

  const payloadObj = {
    method: fetchOptions.method || 'GET',
    body: fetchOptions.body || '',
    // safety issue with file server, just safer to have this
    headers: fetchOptions.headers || {},
    // no initial /
    endpoint: url.pathname.replace(/^\//, ''),
  };
  if (url.search) {
    payloadObj.endpoint += url.search;
  }

  // from https://github.com/sindresorhus/is-stream/blob/master/index.js
  if (
    payloadObj.body &&
    typeof payloadObj.body === 'object' &&
    typeof payloadObj.body.pipe === 'function'
  ) {
    const fData = payloadObj.body.getBuffer();
    const fHeaders = payloadObj.body.getHeaders();
    // update headers for boundary
    payloadObj.headers = { ...payloadObj.headers, ...fHeaders };
    // update body with base64 chunk
    payloadObj.body = {
      fileUpload: fData.toString('base64'),
    };
  }

  let pathNodes = [];
  try {
    pathNodes = await window.OnionPaths.getInstance().getOnionPath();
  } catch (e) {
    log.error(
      `loki_app_dot_net:::sendViaOnion #${options.requestNumber} - getOnionPath Error ${e.code} ${e.message}`
    );
  }
  if (!pathNodes || !pathNodes.length) {
    log.warn(
      `loki_app_dot_net:::sendViaOnion #${options.requestNumber} - failing, no path available`
    );
    // should we retry?
    return {};
  }

  // do the request
  let result;
  try {
    result = await window.NewSnodeAPI.sendOnionRequestLsrpcDest(
      0,
      pathNodes,
      srvPubKey,
      url.host,
      payloadObj,
      options.requestNumber
    );
    if (typeof result === 'number') {
      window.log.error(
        'sendOnionRequestLsrpcDest() returned a number indicating an error: ',
        result
      );
    }
  } catch (e) {
    log.error(
      'loki_app_dot_net:::sendViaOnion - lokiRpcUtils error',
      e.code,
      e.message
    );
    return {};
  }

  // handle error/retries
  if (!result.status) {
    log.error(
      `loki_app_dot_net:::sendViaOnion #${options.requestNumber} - Retry #${options.retry} Couldnt handle onion request, retrying`,
      payloadObj
    );
    if (options.retry && options.retry >= MAX_SEND_ONION_RETRIES) {
      log.error(
        `sendViaOnion too many retries: ${options.retry}. Stopping retries.`
      );
      return {};
    }
    return sendViaOnion(srvPubKey, url, fetchOptions, {
      ...options,
      retry: options.retry + 1,
      counter: options.requestNumber,
    });
  }

  if (options.noJson) {
    return {
      result,
      txtResponse: result.body,
      response: result.body,
    };
  }

  // get the return variables we need
  let response = {};
  let txtResponse = '';

  let { body } = result;
  if (typeof body === 'string') {
    // adn does uses this path
    // log.info(`loki_app_dot_net:::sendViaOnion - got text response ${url.toString()}`);
    txtResponse = result.body;
    try {
      body = JSON.parse(result.body);
    } catch (e) {
      log.error(
        `loki_app_dot_net:::sendViaOnion #${options.requestNumber} - Can't decode JSON body`,
        typeof result.body,
        result.body
      );
    }
  } else {
    // FIXME why is
    // https://chat-dev.lokinet.org/loki/v1/channel/1/deletes?count=200&since_id=
    // difference in response than all the other calls....
    // log.info(
    //   `loki_app_dot_net:::sendViaOnion #${
    //     options.requestNumber
    //   } - got object response ${url.toString()}`
    // );
  }
  // result.status has the http response code
  if (!txtResponse) {
    txtResponse = JSON.stringify(body);
  }
  response = body;
  response.headers = result.headers;

  return { result, txtResponse, response };
};

const serverRequest = async (endpoint, options = {}) => {
  const {
    params = {},
    method,
    rawBody,
    objBody,
    token,
    srvPubKey,
    forceFreshToken = false,
  } = options;

  const url = new URL(endpoint);
  if (!_.isEmpty(params)) {
    url.search = new URLSearchParams(params);
  }
  const fetchOptions = {};
  const headers = {};
  try {
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (method) {
      fetchOptions.method = method;
    }
    if (objBody) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(objBody);
    } else if (rawBody) {
      fetchOptions.body = rawBody;
    }
    fetchOptions.headers = headers;

    // domain ends in .loki
    if (url.host.match(/\.loki$/i)) {
      fetchOptions.agent = snodeHttpsAgent;
    }
  } catch (e) {
    log.error(
      'loki_app_dot_net:::serverRequest - set up error:',
      e.code,
      e.message
    );
    return {
      err: e,
      ok: false,
    };
  }

  let response;
  let result;
  let txtResponse;
  let mode = 'insecureNodeFetch';
  try {
    const host = url.host.toLowerCase();
    // log.info('host', host, FILESERVER_HOSTS);
    if (
      window.lokiFeatureFlags.useFileOnionRequests &&
      FILESERVER_HOSTS.includes(host)
    ) {
      mode = 'sendViaOnion';
      ({ response, txtResponse, result } = await sendViaOnion(
        srvPubKey,
        url,
        fetchOptions,
        options
      ));
    } else if (window.lokiFeatureFlags.useFileOnionRequests) {
      if (!srvPubKey) {
        throw new Error(
          'useFileOnionRequests=true but we do not have a server pubkey set.'
        );
      }
      mode = 'sendViaOnionOG';
      ({ response, txtResponse, result } = await sendViaOnion(
        srvPubKey,
        url,
        fetchOptions,
        options
      ));
    } else {
      // we end up here only if window.lokiFeatureFlags.useFileOnionRequests is false
      log.info(`insecureNodeFetch => plaintext for ${url}`);
      result = await insecureNodeFetch(url, fetchOptions);

      txtResponse = await result.text();
      // cloudflare timeouts (504s) will be html...
      response = options.noJson ? txtResponse : JSON.parse(txtResponse);

      // result.status will always be 200
      // emulate the correct http code if available
      if (response && response.meta && response.meta.code) {
        result.status = response.meta.code;
      }
    }
  } catch (e) {
    if (txtResponse) {
      log.error(
        `loki_app_dot_net:::serverRequest - ${mode} error`,
        e.code,
        e.message,
        `json: ${txtResponse}`,
        'attempting connection to',
        url.toString()
      );
    } else {
      log.error(
        `loki_app_dot_net:::serverRequest - ${mode} error`,
        e.code,
        e.message,
        'attempting connection to',
        url.toString()
      );
    }

    return {
      err: e,
      ok: false,
    };
  }

  if (!result) {
    return {
      err: 'noResult',
      response,
      ok: false,
    };
  }

  // if it's a response style with a meta
  if (result.status !== 200) {
    if (!forceFreshToken && (!response.meta || response.meta.code === 401)) {
      // retry with forcing a fresh token
      return serverRequest(endpoint, {
        ...options,
        forceFreshToken: true,
      });
    }
    return {
      err: 'statusCode',
      statusCode: result.status,
      response,
      ok: false,
    };
  }
  return {
    statusCode: result.status,
    response,
    ok: result.status >= 200 && result.status <= 299,
  };
};

// the core ADN class that handles all communication with a specific server
class LokiAppDotNetServerAPI {
  constructor(ourKey, url) {
    this.ourKey = ourKey;
    this.channels = [];
    this.tokenPromise = null;
    this.baseServerUrl = url;
    log.info(`LokiAppDotNetAPI registered server ${url}`);
  }

  async open() {
    // check token, we're not sure how long we were asleep, token may have expired
    await this.getOrRefreshServerToken();
    // now that we have a working token, start up pollers
    this.channels.forEach(channel => channel.open());
  }

  async close() {
    this.channels.forEach(channel => channel.stop());
    // match sure our pending requests are finished
    // in case it's still starting up
    if (this.tokenPromise) {
      await this.tokenPromise;
    }
  }

  // channel getter/factory
  async findOrCreateChannel(chatAPI, channelId, conversationId) {
    let thisChannel = this.channels.find(
      channel => channel.channelId === channelId
    );
    if (!thisChannel) {
      // make sure we're subscribed
      // eventually we'll need to move to account registration/add server
      await this.serverRequest(`channels/${channelId}/subscribe`, {
        method: 'POST',
      });
      thisChannel = new LokiPublicChannelAPI(
        chatAPI,
        this,
        channelId,
        conversationId
      );
      log.info(
        'LokiPublicChannelAPI started for',
        channelId,
        'on',
        this.baseServerUrl
      );
      this.channels.push(thisChannel);
    }
    return thisChannel;
  }

  async partChannel(channelId) {
    log.info('partChannel', channelId, 'from', this.baseServerUrl);
    await this.serverRequest(`channels/${channelId}/subscribe`, {
      method: 'DELETE',
    });
    this.unregisterChannel(channelId);
  }

  // deallocate resources channel uses
  unregisterChannel(channelId) {
    log.info('unregisterChannel', channelId, 'from', this.baseServerUrl);
    let thisChannel;
    let i = 0;
    for (; i < this.channels.length; i += 1) {
      if (this.channels[i].channelId === channelId) {
        thisChannel = this.channels[i];
        break;
      }
    }
    if (!thisChannel) {
      return;
    }
    thisChannel.stop();
    this.channels.splice(i, 1);
  }

  // set up pubKey & pubKeyHex properties
  // optionally called for mainly file server comms
  getPubKeyForUrl() {
    if (!window.lokiFeatureFlags.useOnionRequests) {
      // pubkeys don't matter
      return '';
    }

    // Hard coded
    let pubKeyAB;
    if (urlPubkeyMap && urlPubkeyMap[this.baseServerUrl]) {
      pubKeyAB = window.Signal.Crypto.base64ToArrayBuffer(
        urlPubkeyMap[this.baseServerUrl]
      );
    }

    // do we have their pubkey locally?
    // FIXME: this._server won't be set yet...
    // can't really do this for the file server because we'll need the key
    // before we can communicate with lsrpc
    if (window.lokiFeatureFlags.useFileOnionRequests) {
      if (
        window.lokiPublicChatAPI &&
        window.lokiPublicChatAPI.openGroupPubKeys &&
        window.lokiPublicChatAPI.openGroupPubKeys[this.baseServerUrl]
      ) {
        pubKeyAB =
          window.lokiPublicChatAPI.openGroupPubKeys[this.baseServerUrl];
      }
    }
    // else will fail validation later

    // now that key is loaded, lets verify
    if (pubKeyAB && pubKeyAB.byteLength && pubKeyAB.byteLength !== 33) {
      log.error('FILESERVER PUBKEY is invalid, length:', pubKeyAB.byteLength);
      process.exit(1);
    }
    this.pubKey = pubKeyAB;
    this.pubKeyHex = StringView.arrayBufferToHex(pubKeyAB);

    return pubKeyAB;
  }

  async setProfileName(profileName) {
    // when we add an annotation, may need this
    /*
    const privKey = await this.getPrivateKey();
    // we might need an annotation that sets the homeserver for media
    // better to include this with each attachment...
    const objToSign = {
      name: profileName,
      version: 1,
      annotations: [],
    };
    const sig = await libsignal.Curve.async.calculateSignature(
      privKey,
      JSON.stringify(objToSign)
    );
    */

    // You cannot use null to clear the profile name
    // the name key has to be set to know what value we want changed
    const pName = profileName || '';

    const res = await this.serverRequest('users/me', {
      method: 'PATCH',
      objBody: {
        name: pName,
      },
    });
    // no big deal if it fails...
    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(
          `setProfileName Error ${res.err} ${res.statusCode}`,
          this.baseServerUrl
        );
      }
      return [];
    }

    // expecting a user object
    return res.response.data.annotations || [];

    // if no profileName should we update the local from the server?
    // no because there will be multiple public chat servers
  }

  async setHomeServer(homeServer) {
    const res = await this.serverRequest('users/me', {
      method: 'PATCH',
      objBody: {
        annotations: [
          {
            type: HOMESERVER_USER_ANNOTATION_TYPE,
            value: homeServer,
          },
        ],
      },
    });

    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(`setHomeServer Error ${res.err}`);
      }
      return [];
    }

    // expecting a user object
    return res.response.data.annotations || [];
  }

  async setAvatar(url, profileKey) {
    let value; // undefined will save bandwidth on the annotation if we don't need it (no avatar)
    if (url && profileKey) {
      value = { url, profileKey };
    }
    return this.setSelfAnnotation(AVATAR_USER_ANNOTATION_TYPE, value);
  }

  // get active token for this server
  async getOrRefreshServerToken(forceRefresh = false) {
    let token;
    if (!forceRefresh) {
      if (this.token) {
        return this.token;
      }
      token = await Signal.Data.getPublicServerTokenByServerUrl(
        this.baseServerUrl
      );
    }
    if (!token) {
      token = await this.refreshServerToken();
      if (token) {
        await Signal.Data.savePublicServerToken({
          serverUrl: this.baseServerUrl,
          token,
        });
      }
    }
    this.token = token;

    // if no token to verify, just bail now
    if (!token) {
      // if we haven't forced it
      if (!forceRefresh) {
        // try one more time with requesting a fresh token
        token = await this.getOrRefreshServerToken(true);
      }
      return token;
    }

    // verify token info
    const tokenRes = await this.serverRequest('token');
    // if no problems and we have data
    if (
      !tokenRes.err &&
      tokenRes.response &&
      tokenRes.response.data &&
      tokenRes.response.data.user
    ) {
      // get our profile name
      // this should be primaryDevicePubKey
      // because the rest of the profile system uses that...
      const ourNumber = window.libsession.Utils.UserUtils.getOurPubKeyStrFromCache();
      const profileConvo = window.getConversationController().get(ourNumber);
      const profile = profileConvo && profileConvo.getLokiProfile();
      const profileName = profile && profile.displayName;
      // if doesn't match, write it to the network
      if (tokenRes.response.data.user.name !== profileName) {
        // update our profile name if it got out of sync
        this.setProfileName(profileName);
      }
    }
    if (tokenRes.err) {
      log.error(`token err`, tokenRes);
      // didn't already try && this specific error
      if (
        !forceRefresh &&
        tokenRes.response &&
        tokenRes.response.meta &&
        tokenRes.response.meta.code === 401
      ) {
        // this token is not good
        this.token = ''; // remove from object
        await Signal.Data.savePublicServerToken({
          serverUrl: this.baseServerUrl,
          token: '',
        });
        token = await this.getOrRefreshServerToken(true);
      }
    }

    return token;
  }

  // get active token from server (but only allow one request at a time)
  async refreshServerToken() {
    // if currently not in progress
    if (this.tokenPromise === null) {
      // FIXME: add timeout
      // a broken/stuck token endpoint can prevent you from removing channels
      // set lock
      this.tokenPromise = new Promise(async res => {
        // request the token
        const token = await this.requestToken();
        if (!token) {
          res(null);
          return;
        }
        // activate the token
        const registered = await this.submitToken(token);
        if (!registered) {
          res(null);
          return;
        }
        // resolve promise to release lock
        res(token);
      });
    }
    // wait until we have it set
    const token = await this.tokenPromise;
    // clear lock
    this.tokenPromise = null;
    return token;
  }

  // request an token from the server
  async requestToken() {
    let res;
    try {
      const params = {
        pubKey: this.ourKey,
      };
      res = await this.serverRequest('loki/v1/get_challenge', {
        method: 'GET',
        params,
      });
    } catch (e) {
      // should we retry here?
      // no, this is the low level function
      // not really an error, from a client's pov, network servers can fail...
      if (e.code === 'ECONNREFUSED') {
        // down
        log.warn(
          'requestToken request can not connect',
          this.baseServerUrl,
          e.message
        );
      } else if (e.code === 'ECONNRESET') {
        // got disconnected
        log.warn(
          'requestToken request lost connection',
          this.baseServerUrl,
          e.message
        );
      } else {
        log.error(
          'requestToken request failed',
          this.baseServerUrl,
          e.code,
          e.message
        );
      }
      return null;
    }
    if (!res.ok) {
      log.error('requestToken request failed');
      return null;
    }
    const body = res.response;
    const token = await libloki.crypto.decryptToken(body);
    return token;
  }

  // activate token
  async submitToken(token) {
    try {
      const res = await this.serverRequest('loki/v1/submit_challenge', {
        method: 'POST',
        objBody: {
          pubKey: this.ourKey,
          token,
        },
        noJson: true,
      });
      return res.ok;
    } catch (e) {
      log.error('submitToken serverRequest failure', e.code, e.message);
      return false;
    }
  }

  // make a request to the server
  async serverRequest(endpoint, options = {}) {
    if (options.forceFreshToken) {
      await this.getOrRefreshServerToken(true);
    }
    return serverRequest(`${this.baseServerUrl}/${endpoint}`, {
      ...options,
      token: this.token,
      srvPubKey: this.pubKey,
    });
  }

  async getUserAnnotations(pubKey) {
    if (!pubKey) {
      log.warn('No pubkey provided to getUserAnnotations!');
      return [];
    }
    const res = await this.serverRequest(`users/@${pubKey}`, {
      method: 'GET',
      params: {
        include_user_annotations: 1,
      },
    });

    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(`getUserAnnotations Error ${res.err}`);
      }
      return [];
    }

    return res.response.data.annotations || [];
  }

  async getModerators(channelId) {
    if (!channelId) {
      log.warn('No channelId provided to getModerators!');
      return [];
    }
    const res = await this.serverRequest(
      `loki/v1/channels/${channelId}/moderators`
    );

    return (!res.err && res.response && res.response.moderators) || [];
  }

  async addModerator(pubKeyStr) {
    const pubkey = `@${pubKeyStr}`;
    const users = await this.getUsers([pubkey]);
    const validUsers = users.filter(user => !!user.id);
    if (!validUsers || validUsers.length === 0) {
      return false;
    }
    const results = await Promise.all(
      validUsers.map(async user => {
        log.info(`POSTing loki/v1/moderators/${user.id}`);
        const res = await this.serverRequest(`loki/v1/moderators/${user.id}`, {
          method: 'POST',
        });
        return !!(!res.err && res.response && res.response.data);
      })
    );

    const anyFailures = results.some(test => !test);
    if (anyFailures) {
      window.log.info('failed to add moderator:', results);
    }
    return !anyFailures;
  }

  async removeModerators(pubKeysParam) {
    let pubKeys = pubKeysParam;
    if (!Array.isArray(pubKeys)) {
      pubKeys = [pubKeys];
    }
    pubKeys = pubKeys.map(key => `@${key}`);
    const users = await this.getUsers(pubKeys);
    const validUsers = users.filter(user => !!user.id);

    const results = await Promise.all(
      validUsers.map(async user => {
        const res = await this.serverRequest(`loki/v1/moderators/${user.id}`, {
          method: 'DELETE',
        });
        return !!(!res.err && res.response && res.response.data);
      })
    );
    const anyFailures = results.some(test => !test);
    if (anyFailures) {
      window.log.info('failed to remove moderator:', results);
    }
    return !anyFailures;
  }

  async getSubscribers(channelId, wantObjects) {
    if (!channelId) {
      log.warn('No channelId provided to getSubscribers!');
      return [];
    }

    let res = {};
    if (!Array.isArray(channelId) && wantObjects) {
      res = await this.serverRequest(`channels/${channelId}/subscribers`, {
        method: 'GET',
        params: {
          include_user_annotations: 1,
        },
      });
    } else {
      // not deployed on all backends yet
      res.err = 'array subscribers endpoint not yet implemented';
      /*
      var list = channelId;
      if (!Array.isArray(list)) {
        list = [channelId];
      }
      const idres = await this.serverRequest(`channels/subscribers/ids`, {
        method: 'GET',
        params: {
          ids: list.join(','),
          include_user_annotations: 1,
        },
      });
      if (wantObjects) {
        if (idres.err || !idres.response || !idres.response.data) {
          if (idres.err) {
            log.error(`Error ${idres.err}`);
          }
          return [];
        }
        const userList = [];
        await Promise.all(idres.response.data.map(async channelId => {
          const channelUserObjs = await this.getUsers(idres.response.data[channelId]);
          userList.push(...channelUserObjs);
        }));
        res = {
          response: {
            meta: {
              code: 200,
            },
            data: userList
          }
        }
      } else {
        res = idres;
      }
      */
    }

    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(`getSubscribers Error ${res.err}`);
      }
      return [];
    }

    return res.response.data || [];
  }

  async getUsers(pubKeys) {
    if (!pubKeys) {
      log.warn('No pubKeys provided to getUsers!');
      return [];
    }
    // ok to call without
    if (!pubKeys.length) {
      return [];
    }
    if (pubKeys.length > 200) {
      log.warn('Too many pubKeys given to getUsers!');
    }
    const res = await this.serverRequest('users', {
      method: 'GET',
      params: {
        ids: pubKeys.join(','),
        include_user_annotations: 1,
      },
    });

    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(
          `loki_app_dot_net:::getUsers - Error: ${res.err} for ${pubKeys.join(
            ','
          )}`
        );
      }
      return [];
    }

    return res.response.data || [];
  }

  // Only one annotation at a time
  async setSelfAnnotation(type, value) {
    const annotation = { type };

    // to delete annotation, omit the "value" field
    if (value) {
      annotation.value = value;
    }

    const res = await this.serverRequest('users/me', {
      method: 'PATCH',
      objBody: {
        annotations: [annotation],
      },
    });

    if (!res.err && res.response) {
      return res.response;
    }

    return false;
  }

  async uploadAvatar(data) {
    const endpoint = 'users/me/avatar';

    const options = {
      method: 'POST',
      rawBody: data,
    };

    const { response, ok } = await this.serverRequest(endpoint, options);

    if (!ok) {
      throw new Error(`Failed to upload avatar to ${this.baseServerUrl}`);
    }

    const url =
      response.data &&
      response.data.avatar_image &&
      response.data.avatar_image.url;

    if (!url) {
      throw new Error(`Failed to upload data: Invalid url.`);
    }

    // We don't use the server id for avatars
    return {
      url,
      id: undefined,
    };
  }

  // for avatar
  async uploadData(data) {
    const endpoint = 'files';
    const options = {
      method: 'POST',
      rawBody: data,
    };

    const { ok, response } = await this.serverRequest(endpoint, options);
    if (!ok) {
      throw new Error(`Failed to upload data to server: ${this.baseServerUrl}`);
    }

    const url = response.data && response.data.url;
    const id = response.data && response.data.id;

    if (!url || !id) {
      throw new Error(`Failed to upload data: Invalid url or id returned.`);
    }

    return {
      url,
      id,
    };
  }

  // for files
  putAttachment(attachmentBin) {
    const formData = new FormData();
    const buffer = Buffer.from(attachmentBin);
    formData.append('type', 'network.loki');
    formData.append('content', buffer, {
      contentType: 'application/octet-stream',
      name: 'content',
      filename: 'attachment',
      knownLength: buffer.byteLength,
    });

    return this.uploadData(formData);
  }

  putAvatar(buf) {
    const formData = new FormData();
    const buffer = Buffer.from(buf);
    formData.append('avatar', buffer, {
      contentType: 'application/octet-stream',
      name: 'avatar',
      filename: 'attachment',
    });
    return this.uploadAvatar(formData);
  }

  // This should return Uint8Array in response.data
  async downloadAttachment(url) {
    const endpoint = new URL(url).pathname;

    // With the new protocol, there is no json in body, we shouldn't try to parse it
    const noJson = window.lokiFeatureFlags.useFileOnionRequestsV2;

    const res = await this.serverRequest(`loki/v1${endpoint}`, {
      method: 'GET',
      noJson,
    });

    if (window.lokiFeatureFlags.useFileOnionRequestsV2) {
      const buffer = dcodeIO.ByteBuffer.fromBase64(
        res.response
      ).toArrayBuffer();
      return buffer;
    }
    return new Uint8Array(res.response.data).buffer;
  }
}

// functions to a specific ADN channel on an ADN server
class LokiPublicChannelAPI {
  constructor(_, serverAPI, channelId, conversationId) {
    // properties
    this.serverAPI = serverAPI;
    this.channelId = channelId;
    this.baseChannelUrl = `channels/${this.channelId}`;
    this.conversationId = conversationId;
    this.conversation = window
      .getConversationController()
      .getOrThrow(conversationId);
    this.lastMessageServerID = null;
    this.modStatus = false;
    this.deleteLastId = 1;
    this.timers = {};
    this.myPrivateKey = false;
    this.messagesPollLock = false;

    // can escalated to SQL if it start uses too much memory
    this.logMop = {};

    // Cache for duplicate checking
    this.lastMessagesCache = [];

    // end properties

    log.info(
      `registered LokiPublicChannel ${channelId} on ${this.serverAPI.baseServerUrl}`
    );
    // start polling
    this.open();
  }

  async getPrivateKey() {
    if (!this.myPrivateKey) {
      const item = await window.Signal.Data.getItemById('identityKey');
      const keyPair = (item && item.value) || undefined;
      if (!keyPair) {
        window.log.error('Could not get our Keypair from getItemById');
      }
      this.myPrivateKey = keyPair.privKey;
    }
    return this.myPrivateKey;
  }

  async banUser(pubkey) {
    const res = await this.serverRequest(
      `loki/v1/moderation/blacklist/@${pubkey}`,
      {
        method: 'POST',
      }
    );

    if (res.err || !res.response || !res.response.data) {
      if (res.err) {
        log.error(`banUser Error ${res.err}`);
      }
      return false;
    }

    return true;
  }

  open() {
    log.info(
      `LokiPublicChannel open ${this.channelId} on ${this.serverAPI.baseServerUrl}`
    );
    if (this.running) {
      log.warn(
        `LokiPublicChannel already open ${this.channelId} on ${this.serverAPI.baseServerUrl}`
      );
    }
    this.running = true;
    if (!this.timers.channel) {
      this.pollForChannel();
    }
    if (!this.timers.moderator) {
      this.pollForModerators();
    }
    if (!this.timers.delete) {
      this.pollForDeletions();
    }
    if (!this.timers.message) {
      this.pollForMessages();
    }
    // TODO: poll for group members here?
  }

  stop() {
    log.info(
      `LokiPublicChannel close ${this.channelId} on ${this.serverAPI.baseServerUrl}`
    );
    if (!this.running) {
      log.warn(
        `LokiPublicChannel already open ${this.channelId} on ${this.serverAPI.baseServerUrl}`
      );
    }
    this.running = false;
    if (this.timers.channel) {
      clearTimeout(this.timers.channel);
      this.timers.channel = false;
    }
    if (this.timers.moderator) {
      clearTimeout(this.timers.moderator);
      this.timers.moderator = false;
    }
    if (this.timers.delete) {
      clearTimeout(this.timers.delete);
      this.timers.delete = false;
    }
    if (this.timers.message) {
      clearTimeout(this.timers.message);
      this.timers.message = false;
    }
  }

  serverRequest(endpoint, options = {}) {
    return this.serverAPI.serverRequest(endpoint, options);
  }

  getSubscribers() {
    return this.serverAPI.getSubscribers(this.channelId, true);
  }

  getModerators() {
    return this.serverAPI.getModerators(this.channelId);
  }

  // get moderation actions
  async pollForModerators() {
    try {
      await this.pollOnceForModerators();
    } catch (e) {
      log.warn(
        'Error while polling for public chat moderators:',
        e.code,
        e.message
      );
    }
    if (this.running) {
      this.timers.moderator = setTimeout(() => {
        this.pollForModerators();
      }, PUBLICCHAT_MOD_POLL_EVERY);
    }
  }

  // get moderator status
  async pollOnceForModerators() {
    // get moderator status
    const res = await this.serverRequest(
      `loki/v1/channels/${this.channelId}/moderators`
    );
    const ourNumberDevice = window.libsession.Utils.UserUtils.getOurPubKeyStrFromCache();

    // Get the list of moderators if no errors occurred
    const moderators = !res.err && res.response && res.response.moderators;

    // if we encountered problems then we'll keep the old mod status
    if (moderators) {
      this.modStatus = moderators.includes(ourNumberDevice);
    }

    if (this.running) {
      await this.conversation.updateGroupAdmins(moderators || []);
    }
  }

  async setChannelSettings(settings) {
    if (!this.modStatus) {
      // need moderator access to set this
      log.warn('Need moderator access to setChannelName');
      return false;
    }
    // racy!
    const res = await this.serverRequest(this.baseChannelUrl, {
      params: { include_annotations: 1 },
    });
    if (res.err) {
      // state unknown
      log.warn(`public chat channel state unknown, skipping set: ${res.err}`);
      return false;
    }
    let notes =
      res.response && res.response.data && res.response.data.annotations;
    if (!notes) {
      // ok if nothing is set yet
      notes = [];
    }
    let settingNotes = notes.filter(
      note => note.type === SETTINGS_CHANNEL_ANNOTATION_TYPE
    );
    if (!settingNotes) {
      // default name, description, avatar
      settingNotes = [
        {
          type: SETTINGS_CHANNEL_ANNOTATION_TYPE,
          value: {
            name: 'Your Public Chat',
            description: 'Your public chat room',
            avatar: null,
          },
        },
      ];
    }
    // update settings
    settingNotes[0].value = Object.assign(settingNotes[0].value, settings);
    // commit settings
    const updateRes = await this.serverRequest(
      `loki/v1/${this.baseChannelUrl}`,
      { method: 'PUT', objBody: { annotations: settingNotes } }
    );
    if (updateRes.err || !updateRes.response || !updateRes.response.data) {
      if (updateRes.err) {
        log.error(`setChannelSettings Error ${updateRes.err}`);
      }
      return false;
    }
    return true;
  }

  // Do we need this? They definitely make it more clear...
  setChannelName(name) {
    return this.setChannelSettings({ name });
  }
  setChannelDescription(description) {
    return this.setChannelSettings({ description });
  }
  setChannelAvatar(avatar) {
    return this.setChannelSettings({ avatar });
  }

  // delete messages on the server
  async deleteMessages(serverIds, canThrow = false) {
    const res = await this.serverRequest(
      this.modStatus ? `loki/v1/moderation/messages` : `loki/v1/messages`,
      { method: 'DELETE', params: { ids: serverIds } }
    );
    if (!res.err) {
      const deletedIds = res.response.data
        .filter(d => d.is_deleted)
        .map(d => d.id);

      if (deletedIds.length > 0) {
        log.info(`deleted ${serverIds} on ${this.baseChannelUrl}`);
      }

      const failedIds = res.response.data
        .filter(d => !d.is_deleted)
        .map(d => d.id);

      if (failedIds.length > 0) {
        log.warn(`failed to delete ${failedIds} on ${this.baseChannelUrl}`);
      }

      // Note: if there is no entry for message, we assume it wasn't found
      // on the server, so it is not treated as explicitly failed
      const ignoredIds = _.difference(
        serverIds,
        _.union(failedIds, deletedIds)
      );

      if (ignoredIds.length > 0) {
        log.warn(`No response for ${ignoredIds} on ${this.baseChannelUrl}`);
      }

      return { deletedIds, ignoredIds };
    }
    if (canThrow) {
      throw new textsecure.PublicChatError(
        'Failed to delete public chat message'
      );
    }
    return { deletedIds: [], ignoredIds: [] };
  }

  // used for sending messages
  getEndpoint() {
    const endpoint = `${this.serverAPI.baseServerUrl}/${this.baseChannelUrl}/messages`;
    return endpoint;
  }

  // get moderation actions
  async pollForChannel() {
    try {
      await this.pollForChannelOnce();
    } catch (e) {
      log.warn(
        'Error while polling for public chat room details',
        e.code,
        e.message
      );
    }
    if (this.running) {
      this.timers.channel = setTimeout(() => {
        this.pollForChannel();
      }, PUBLICCHAT_CHAN_POLL_EVERY);
    }
  }

  // update room details
  async pollForChannelOnce() {
    const res = await this.serverRequest(`${this.baseChannelUrl}`, {
      params: {
        include_annotations: 1,
      },
    });

    if (res.err || !res.response || !res.response.data) {
      if (res.statusCode === 403) {
        // token is now invalid
        this.serverAPI.getOrRefreshServerToken(true);
      }
      return;
    }
    if (!this.running) {
      return;
    }

    const { data } = res.response;

    if (data.annotations && data.annotations.length) {
      // get our setting note
      const settingNotes = data.annotations.filter(
        note => note.type === SETTINGS_CHANNEL_ANNOTATION_TYPE
      );
      const note = settingNotes && settingNotes.length ? settingNotes[0] : {};
      // setting_note.value.description only needed for directory
      if (note.value && note.value.name) {
        this.conversation.setGroupName(note.value.name);
      }
      if (note.value && note.value.avatar) {
        if (note.value.avatar.match(/^images\//)) {
          // local file avatar
          const resolvedAvatar = path.normalize(note.value.avatar);
          const base = path.normalize('images/');
          const re = new RegExp(`^${base}`);
          // do we at least ends up inside images/ somewhere?
          if (re.test(resolvedAvatar)) {
            this.conversation.set('avatar', resolvedAvatar);
          }
        } else {
          // relative URL avatar
          const avatarAbsUrl = this.serverAPI.baseServerUrl + note.value.avatar;
          const {
            writeNewAttachmentData,
            deleteAttachmentData,
          } = window.Signal.Migrations;
          // do we already have this image? no, then

          // download a copy and save it
          const imageData = await this.serverAPI.downloadAttachment(
            avatarAbsUrl
          );

          const newAttributes = await window.Signal.Types.Conversation.maybeUpdateAvatar(
            this.conversation.attributes,
            imageData,
            {
              writeNewAttachmentData,
              deleteAttachmentData,
            }
          );
          // update group
          this.conversation.set('avatar', newAttributes.avatar);
        }
      }
      // is it mutable?
      // who are the moderators?
      // else could set a default in case of server problems...
    }

    if (data.counts && Number.isInteger(data.counts.subscribers)) {
      this.conversation.setSubscriberCount(data.counts.subscribers);
    }
    await this.conversation.commit();
  }

  // get moderation actions
  async pollForDeletions() {
    try {
      await this.pollOnceForDeletions();
    } catch (e) {
      log.warn(
        'Error while polling for public chat deletions:',
        e.code,
        e.message
      );
    }
    if (this.running) {
      this.timers.delete = setTimeout(() => {
        this.pollForDeletions();
      }, PUBLICCHAT_DELETION_POLL_EVERY);
    }
  }

  async pollOnceForDeletions() {
    // grab the last 200 deletions
    const params = {
      count: 200,
    };

    // start loop
    let more = true;
    while (more) {
      // set params to from where we last checked
      params.since_id = this.deleteLastId;

      // grab the next 200 deletions from where we last checked
      // eslint-disable-next-line no-await-in-loop
      const res = await this.serverRequest(
        `loki/v1/channel/${this.channelId}/deletes`,
        { params }
      );

      // if any problems, abort out
      if (
        res.err ||
        !res.response ||
        !res.response.data ||
        !res.response.meta
      ) {
        if (res.statusCode === 403) {
          // token is now invalid
          this.serverAPI.getOrRefreshServerToken(true);
        }
        if (res.err) {
          log.error(`pollOnceForDeletions Error ${res.err}`);
        } else {
          log.error(
            `pollOnceForDeletions Error: Received incorrect response ${res.response}`
          );
        }
        break;
      }

      // Process results
      const entries = res.response.data || [];
      if (entries.length > 0) {
        Whisper.events.trigger('deleteLocalPublicMessages', {
          messageServerIds: entries.reverse().map(e => e.message_id),
          conversationId: this.conversationId,
        });
      }

      // update where we last checked
      this.deleteLastId = res.response.meta.max_id;
      more =
        res.response.meta.more &&
        res.response.data.length >= params.count &&
        this.running;
    }
  }

  static getSigData(
    sigVer,
    noteValue,
    attachmentAnnotations,
    previewAnnotations,
    adnMessage
  ) {
    let sigString = '';
    sigString += adnMessage.text.trim();
    sigString += noteValue.timestamp;
    if (noteValue.quote) {
      sigString += noteValue.quote.id;
      sigString += noteValue.quote.author;
      sigString += noteValue.quote.text.trim();
      if (adnMessage.reply_to) {
        sigString += adnMessage.reply_to;
      }
    }
    sigString += [...attachmentAnnotations, ...previewAnnotations]
      .map(data => data.id || (data.image && data.image.id))
      .sort()
      .join('');
    sigString += sigVer;

    return dcodeIO.ByteBuffer.wrap(sigString, 'utf8').toArrayBuffer();
  }

  async getMessengerData(adnMessage) {
    if (
      !Array.isArray(adnMessage.annotations) ||
      adnMessage.annotations.length === 0
    ) {
      return false;
    }
    const noteValue = adnMessage.annotations[0].value;

    // signatures now required
    if (!noteValue.sig || typeof noteValue.sig !== 'string') {
      return false;
    }

    // timestamp is the only required field we've had since the first deployed version
    const { timestamp, quote } = noteValue;

    let profileKey = null;
    let avatar = null;
    const avatarNote = adnMessage.user.annotations.find(
      note => note.type === AVATAR_USER_ANNOTATION_TYPE
    );
    if (avatarNote) {
      ({ profileKey, url: avatar } = avatarNote.value);
    }

    if (quote) {
      // Disable quote attachments
      quote.attachments = [];
    }

    // try to verify signature
    const { sig, sigver } = noteValue;
    const annoCopy = [...adnMessage.annotations];
    const attachments = annoCopy
      .filter(anno => anno.value.lokiType === LOKI_ATTACHMENT_TYPE)
      .map(attachment => ({ isRaw: true, ...attachment.value }));
    const preview = annoCopy
      .filter(anno => anno.value.lokiType === LOKI_PREVIEW_TYPE)
      .map(LokiPublicChannelAPI.getPreviewFromAnnotation);
    // strip out sig and sigver
    annoCopy[0] = _.omit(annoCopy[0], ['value.sig', 'value.sigver']);
    const sigData = LokiPublicChannelAPI.getSigData(
      sigver,
      noteValue,
      attachments,
      preview,
      adnMessage
    );

    const pubKeyBin = StringView.hexToArrayBuffer(adnMessage.user.username);
    const sigBin = StringView.hexToArrayBuffer(sig);
    try {
      await libsignal.Curve.async.verifySignature(pubKeyBin, sigData, sigBin);
    } catch (e) {
      if (e.message === 'Invalid signature') {
        // keep noise out of the logs, once per start up is enough
        if (this.logMop[adnMessage.id] === undefined) {
          log.warn(
            'Invalid or missing signature on ',
            this.serverAPI.baseServerUrl,
            this.channelId,
            adnMessage.id,
            'says',
            adnMessage.text,
            'from',
            adnMessage.user.username,
            'signature',
            sig,
            'signature version',
            sigver
          );
          this.logMop[adnMessage.id] = true;
        }
        // we now only accept valid messages into the public chat
        return false;
      }
      // any error should cause problem
      log.error(`Unhandled message signature validation error ${e.message}`);
      return false;
    }

    return {
      timestamp,
      serverTimestamp:
        new Date(`${adnMessage.created_at}`).getTime() || timestamp,
      attachments,
      preview,
      quote,
      avatar,
      text: adnMessage.text,
      profileKey,
    };
  }

  // get channel messages
  async pollForMessages() {
    try {
      await this.pollOnceForMessages();
    } catch (e) {
      log.warn(
        'Error while polling for public chat messages:',
        e.code,
        e.message
      );
    }
    if (this.running) {
      this.timers.message = setTimeout(() => {
        this.pollForMessages();
      }, PUBLICCHAT_MSG_POLL_EVERY);
    }
  }

  async pollOnceForMessages() {
    if (this.messagesPollLock) {
      // TODO: check if lock is stale
      log.warn(
        'pollOnceForModerators locked',
        'on',
        this.channelId,
        'at',
        this.serverAPI.baseServerUrl
      );
      return;
    }
    // disable locking system for now as it's not quite perfect yet
    // this.messagesPollLock = Date.now();

    const params = {
      include_annotations: 1,
      include_user_annotations: 1, // to get the home server
      include_deleted: false,
    };
    if (!this.conversation) {
      log.warn('Trying to poll for non-existing public conversation');
      this.lastMessageServerID = 0;
    } else if (!this.lastMessageServerID) {
      this.lastMessageServerID = this.conversation.getLastRetrievedMessage();
    }
    // If lastMessageServerID is not set, it's the first pull of messages for this open group.
    // We just pull 100 messages (server sends the most recent ones)
    if (!this.lastMessageServerID || this.lastMessageServerID === 0) {
      params.count = 100;
    } else {
      // if lastMessageServerID is set, we pull 200 messages per 200 messages, giving the since_id parameter set to our last received message id.
      params.count = 200;
      params.since_id = this.lastMessageServerID;
    }
    // log.info(`Getting ${params.count} from ${this.lastMessageServerID} on ${this.baseChannelUrl}`);
    const res = await this.serverRequest(`${this.baseChannelUrl}/messages`, {
      params,
    });

    if (res.err || !res.response) {
      if (res.statusCode === 403) {
        // token is now invalid
        this.serverAPI.getOrRefreshServerToken(true);
      }
      log.error(
        `app_dot_net:::pollOnceForMessages - Could not get messages from`,
        this.serverAPI.baseServerUrl,
        this.baseChannelUrl
      );
      if (res.err) {
        log.error(`app_dot_net:::pollOnceForMessages - receive error`, res.err);
      }
      this.messagesPollLock = false;
      return;
    }

    let receivedAt = new Date().getTime();
    const homeServerPubKeys = {};
    let pendingMessages = [];

    // get our profile name
    const ourNumberDevice = window.libsession.Utils.UserUtils.getOurPubKeyStrFromCache();
    // if no primaryDevicePubKey fall back to ourNumberDevice
    const ourNumberProfile =
      window.storage.get('primaryDevicePubKey') || ourNumberDevice;
    let lastProfileName = false;

    // the signature forces this to be async
    pendingMessages = await Promise.all(
      // process these in chronological order
      res.response.data.reverse().map(async adnMessage => {
        // still update our last received if deleted, not signed or not valid
        this.lastMessageServerID = !this.lastMessageServerID
          ? adnMessage.id
          : Math.max(this.lastMessageServerID, adnMessage.id);

        if (
          !adnMessage.id ||
          !adnMessage.user ||
          !adnMessage.user.username || // pubKey lives in the username field
          !adnMessage.text ||
          adnMessage.is_deleted
        ) {
          return false; // Invalid or delete message
        }

        const pubKey = adnMessage.user.username;
        try {
          const messengerData = await this.getMessengerData(adnMessage);

          if (messengerData === false) {
            return false;
          }
          // eslint-disable-next-line no-param-reassign
          adnMessage.timestamp = messengerData.timestamp;
          // eslint-disable-next-line no-param-reassign
          adnMessage.body = messengerData.text;
          const {
            timestamp,
            serverTimestamp,
            quote,
            attachments,
            preview,
            avatar,
            profileKey,
          } = messengerData;
          if (!timestamp) {
            return false; // Invalid message
          }

          // Duplicate check
          // message is one of the object of this.lastMessagesCache
          // testedMessage is the adnMessage object
          const isDuplicate = (message, testedMessage) =>
            DataMessage.isDuplicate(
              message,
              testedMessage,
              testedMessage.user.username
            );
          const isThisMessageDuplicate = this.lastMessagesCache.some(m =>
            isDuplicate(m, adnMessage)
          );

          // Filter out any messages that we got previously
          if (isThisMessageDuplicate) {
            return false; // Duplicate message
          }

          // Add the message to the lastMessage cache and keep the last 5 recent messages
          this.lastMessagesCache = [
            ...this.lastMessagesCache,
            {
              attributes: {
                source: pubKey,
                body: adnMessage.text,
                sent_at: timestamp,
                serverId: adnMessage.id,
              },
            },
          ].splice(-5);
          const from = adnMessage.user.name || 'Anonymous'; // profileName

          // if us
          if (pubKey === ourNumberProfile || pubKey === ourNumberDevice) {
            // update the last name we saw from ourself
            lastProfileName = from;
          }

          // track sources for multidevice support
          // sort it by home server
          let homeServer = window.getDefaultFileServer();
          if (adnMessage.user && adnMessage.user.annotations.length) {
            const homeNotes = adnMessage.user.annotations.filter(
              note => note.type === HOMESERVER_USER_ANNOTATION_TYPE
            );
            // FIXME: this annotation should probably be signed and verified...
            homeServer = homeNotes.reduce(
              (curVal, note) => (note.value ? note.value : curVal),
              homeServer
            );
          }
          if (homeServerPubKeys[homeServer] === undefined) {
            homeServerPubKeys[homeServer] = [];
          }
          if (homeServerPubKeys[homeServer].indexOf(`@${pubKey}`) === -1) {
            homeServerPubKeys[homeServer].push(`@${pubKey}`);
          }

          // generate signal message object
          const messageData = {
            serverId: adnMessage.id,
            clientVerified: true,
            source: pubKey,
            sourceDevice: 1,
            timestamp, // sender timestamp

            serverTimestamp, // server created_at, used to order messages
            receivedAt,
            isPublic: true,
            message: {
              body:
                adnMessage.text === timestamp.toString() ? '' : adnMessage.text,
              attachments,
              group: {
                id: this.conversationId,
                type: textsecure.protobuf.GroupContext.Type.DELIVER,
              },
              flags: 0,
              expireTimer: 0,
              profileKey,
              timestamp,
              received_at: receivedAt,
              sent_at: timestamp, // sender timestamp inner
              quote,
              contact: [],
              preview,
              profile: {
                displayName: from,
                avatar,
              },
            },
          };
          receivedAt += 1; // Ensure different arrival times

          // now process any user meta data updates
          // - update their conversation with a potentially new avatar
          return messageData;
        } catch (e) {
          window.log.error('pollOnceForMessages: caught error:', e);
          return false;
        }
      })
    );
    // return early if we should stop processing
    if (!pendingMessages.length || !this.running) {
      this.conversation.setLastRetrievedMessage(this.lastMessageServerID);
      this.messagesPollLock = false;
      return;
    }

    // filter out invalid messages
    pendingMessages = pendingMessages.filter(messageData => !!messageData);

    // process all messages in the order received

    // trigger the handling of those messages sequentially

    // eslint-disable-next-line no-plusplus
    for (let index = 0; index < pendingMessages.length; index++) {
      if (this.running) {
        // log.info(
        //   'emitting pending public message',
        //   pendingMessages[index].serverId,
        //   'on',
        //   this.channelId,
        //   'at',
        //   this.serverAPI.baseServerUrl
        // );
        // eslint-disable-next-line no-await-in-loop
        window.NewReceiver.handlePublicMessage(pendingMessages[index]);
      }
    }

    /* eslint-enable no-param-reassign */

    // if we received one of our own messages
    if (lastProfileName !== false) {
      // get current profileName
      const profileConvo = window
        .getConversationController()
        .get(ourNumberProfile);
      const profileName = profileConvo.getProfileName();
      // check to see if it out of sync
      if (profileName !== lastProfileName) {
        // out of sync, update this server
        this.serverAPI.setProfileName(profileName);
      }
    }

    // finally update our position
    this.conversation.setLastRetrievedMessage(this.lastMessageServerID);
    this.messagesPollLock = false;
  }

  static getPreviewFromAnnotation(annotation) {
    const preview = {
      title: annotation.value.linkPreviewTitle,
      url: annotation.value.linkPreviewUrl,
      image: {
        isRaw: true,
        caption: annotation.value.caption,
        contentType: annotation.value.contentType,
        digest: annotation.value.digest,
        fileName: annotation.value.fileName,
        flags: annotation.value.flags,
        height: annotation.value.height,
        id: annotation.value.id,
        key: annotation.value.key,
        size: annotation.value.size,
        thumbnail: annotation.value.thumbnail,
        url: annotation.value.url,
        width: annotation.value.width,
      },
    };
    return preview;
  }

  static getAnnotationFromPreview(preview) {
    const annotation = {
      type: MESSAGE_ATTACHMENT_TYPE,
      value: {
        // Mandatory ADN fields
        version: '1.0',
        lokiType: LOKI_PREVIEW_TYPE,

        // Signal stuff we actually care about
        linkPreviewTitle: preview.title,
        linkPreviewUrl: preview.url,
        caption: (preview.image && preview.image.caption) || undefined,
        contentType: (preview.image && preview.image.contentType) || undefined,
        digest: (preview.image && preview.image.digest) || undefined,
        fileName: (preview.image && preview.image.fileName) || undefined,
        flags: (preview.image && preview.image.flags) || undefined,
        height: (preview.image && preview.image.height) || undefined,
        id: (preview.image && preview.image.id) || undefined,
        key: (preview.image && preview.image.key) || undefined,
        size: (preview.image && preview.image.size) || undefined,
        thumbnail: (preview.image && preview.image.thumbnail) || undefined,
        url: (preview.image && preview.image.url) || undefined,
        width: (preview.image && preview.image.width) || undefined,
      },
    };
    return annotation;
  }

  static getAnnotationFromAttachment(attachment) {
    let type;
    if (attachment.contentType.match(/^image/)) {
      type = 'photo';
    } else if (attachment.contentType.match(/^video/)) {
      type = 'video';
    } else if (attachment.contentType.match(/^audio/)) {
      type = 'audio';
    } else {
      type = 'other';
    }
    const annotation = {
      type: MESSAGE_ATTACHMENT_TYPE,
      value: {
        // Mandatory ADN fields
        version: '1.0',
        type,
        lokiType: LOKI_ATTACHMENT_TYPE,

        // Signal stuff we actually care about
        ...attachment,
      },
    };
    return annotation;
  }

  // create a message in the channel
  async sendMessage(data, messageTimeStamp) {
    const { quote, attachments, preview } = data;
    const text = data.body || messageTimeStamp.toString();
    const attachmentAnnotations = attachments.map(
      LokiPublicChannelAPI.getAnnotationFromAttachment
    );
    const previewAnnotations = preview.map(
      LokiPublicChannelAPI.getAnnotationFromPreview
    );

    const payload = {
      text,
      annotations: [
        {
          type: 'network.loki.messenger.publicChat',
          value: {
            timestamp: messageTimeStamp,
          },
        },
        ...attachmentAnnotations,
        ...previewAnnotations,
      ],
    };

    if (quote && quote.id) {
      payload.annotations[0].value.quote = quote;

      // copied from model/message.js copyFromQuotedMessage
      const collection = await Signal.Data.getMessagesBySentAt(quote.id);
      const found = collection.find(item => {
        const messageAuthor = item.getContact();

        return messageAuthor && quote.author === messageAuthor.id;
      });

      if (found) {
        const queryMessage = getMessageController().register(found.id, found);
        const replyTo = queryMessage.get('serverId');
        if (replyTo) {
          payload.reply_to = replyTo;
        }
      }
    }
    const privKey = await this.getPrivateKey();
    const sigVer = 1;
    const mockAdnMessage = { text };
    if (payload.reply_to) {
      mockAdnMessage.reply_to = payload.reply_to;
    }
    const sigData = LokiPublicChannelAPI.getSigData(
      sigVer,
      payload.annotations[0].value,
      attachmentAnnotations.map(anno => anno.value),
      previewAnnotations.map(anno => anno.value),
      mockAdnMessage
    );
    const sig = await libsignal.Curve.async.calculateSignature(
      privKey,
      sigData
    );
    payload.annotations[0].value.sig = StringView.arrayBufferToHex(sig);
    payload.annotations[0].value.sigver = sigVer;
    const res = await this.serverRequest(`${this.baseChannelUrl}/messages`, {
      method: 'POST',
      objBody: payload,
    });
    if (!res.err && res.response) {
      return {
        serverId: res.response.data.id,
        serverTimestamp: new Date(`${res.response.data.created_at}`).getTime(),
      };
    }
    if (res.err) {
      log.error(`POST ${this.baseChannelUrl}/messages failed`);
      if (res.response && res.response.meta && res.response.meta.code === 401) {
        log.error(`Got invalid token for ${this.serverAPI.token}`);
      }
      log.error(res.err);
      log.error(res.response);
    } else {
      log.warn(res.response);
    }

    return { serverId: -1, serverTimestamp: -1 };
  }
}

LokiAppDotNetServerAPI.serverRequest = serverRequest;
LokiAppDotNetServerAPI.sendViaOnion = sendViaOnion;

// These files are expected to be in commonjs so we can't use es6 syntax :(
// If we move these to TS then we should be able to use es6
module.exports = LokiAppDotNetServerAPI;
