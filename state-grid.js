/**
 * 网上国网电费查询 - 完全按照95598.js逻辑
 *
 * 环境变量:
 *   SGCC_USERNAME     - 网上国网账号
 *   SGCC_PASSWORD     - 网上国网密码
 *   SGCC_DEBUG        - 调试模式 (可选, 设为1或true开启详细日志)
 *   SGCC_MQTT_HOST    - MQTT服务器地址 (可选)
 *   SGCC_MQTT_PORT    - MQTT服务器端口 (可选, 默认1883)
 *   SGCC_MQTT_USER    - MQTT用户名 (可选)
 *   SGCC_MQTT_PASS    - MQTT密码 (可选)
 *
 * MQTT订阅主题: nodejs/state-grid/{用电户号}
 */

const https = require('https');

// ========== 配置 ==========
const DEBUG = /^(1|true|yes)$/i.test(process.env.SGCC_DEBUG || '');

const PROXY_HOST = 'api.120399.xyz';
const SGCC_HOST = 'www.95598.cn';
const PROXY_BASE = `https://${PROXY_HOST}/wsgw`;
const SGCC_BASE = `https://${SGCC_HOST}`;

// ========== 日志函数 ==========
const log = {
  info: (msg) => console.log(msg),
  debug: (msg) => DEBUG && console.log('  [DEBUG] ' + msg),
  step: (n, msg) => console.log(`\n[${n}] ${msg}`),
  ok: (msg) => console.log('  ✓ ' + msg),
  err: (msg) => console.error('  ✗ ' + msg),
  data: (msg) => DEBUG && console.log('  → ' + msg)
};

// 基础请求头 (对应95598.js的q配置)
const BASE_HEADERS = {
  "Content-Type": "application/json;charset=UTF-8",
  "Accept": "application/json;charset=UTF-8",
  "version": "1.0",
  "source": "0901",
  "wsgwType": "web"
};

// 风控上下文 (存储deviceTokenTX)
globalThis.riskContext = {};

// ========== HTTP请求 ==========

// 通用fetch请求
const fetchRequest = async (url, options) => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = options.body || options.data;

    // 删除可能冲突的headers
    const headers = { ...options.headers };
    delete headers.Host;
    delete headers['Content-Length'];
    delete headers['content-length'];

    const req = https.request({
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'POST',
      headers: headers,
      timeout: (options.timeout || 30) * 1000
    }, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(data);
        const body = buffer.toString('utf-8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusCode: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: body,
          data: (() => { try { return JSON.parse(body); } catch { return body; } })()
        });
      });
    });

    req.on('error', (e) => reject(new Error(e.message)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
};

// ========== 风控接口 (对应95598.js /s4端点) ==========

async function getRiskContext() {
  log.step('0', '获取风控token...');

  const response = await fetchRequest(`${PROXY_BASE}/s4`, {
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      yuheng: {
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        href: 'https://www.95598.cn/osgweb/login',
        referer: 'https://www.95598.cn/osgweb/login',
        ip: ''
      }
    })
  });

  log.data('风控响应: ' + response.body.slice(0, 100));

  if (!response.data?.data?.tdcItoken) {
    throw new Error('获取风控token失败: ' + response.body);
  }

  const riskData = response.data.data;
  globalThis.riskContext.deviceToken = riskData.tdcItoken;

  log.ok('风控token获取成功');
  return riskData;
}

// ========== 加密解密函数 ==========

/**
 * 构建请求头 (对应95598.js Fr函数)
 */
const buildHeaders = (config) => {
  const timestamp = config.headers?.timestamp || Date.now();
  return {
    ...BASE_HEADERS,
    timestamp: String(timestamp),
    ...(config.headers || {})
  };
};

/**
 * 合并请求参数 (对应95598.js Kr函数)
 */
const mergeConfig = (config, headers) => {
  return {
    ...config,
    headers: {
      ...headers,
      ...(globalThis.riskContext.deviceToken ? { deviceTokenTX: globalThis.riskContext.deviceToken } : {})
    }
  };
};

/**
 * 加密请求 (对应95598.js /s1端点)
 */
const encryptRequest = async (config) => {
  log.debug('加密请求...');

  // 构建完整请求参数
  const headers = buildHeaders(config);
  const mergedConfig = mergeConfig(config, headers);

  // 发送到代理加密端点
  const response = await fetchRequest(`${PROXY_BASE}/s1`, {
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yuheng: mergedConfig })
  });

  if (!response.data?.data) {
    throw new Error('加密失败: ' + response.body);
  }

  const encrypted = response.data.data;
  log.debug('加密完成, encryptKey: ' + (encrypted.encryptKey ? '已获取' : '无'));

  // 处理加密结果
  encrypted.url = `${SGCC_BASE}${encrypted.url}`;

  // 根据Content-Type决定body格式
  const contentType = encrypted.headers?.['Content-Type'] || encrypted.headers?.['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    // authorize请求: body已经是字符串形式
    encrypted.body = encrypted.data;
  } else {
    // 其他请求: JSON格式
    encrypted.body = JSON.stringify(encrypted.data);
  }
  delete encrypted.data;

  return encrypted;
};

/**
 * 解密响应 (对应95598.js /s2端点)
 */
const decryptResponse = async (decryptParams) => {
  log.debug('解密响应...');

  const response = await fetchRequest(`${PROXY_BASE}/s2`, {
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ yuheng: decryptParams })
  });

  const resData = response.data?.data || response.data;
  const { code, message, data } = resData;

  // code=1 表示成功
  if (code && String(code) !== '1' && String(code) !== '1') {
    // RK1003/clickImg 验证码处理
    if (String(code) === 'RK1003' || /网络连接超时/.test(message || '')) {
      console.log('  → 检测到RK1003验证码, 需要重试');
      return { needRetry: true, code: code, message: message };
    }
    // 登录态失效错误码
    if ([10010, 30010, 10015, 10108, 10009, 10207, 10005, 20103].includes(Number(code))) {
      throw new Error(message || '登录态失效');
    }
    throw new Error(message || '请求失败: code=' + code);
  }

  console.log('  → 解密成功');
  return data || resData;
};

// ========== 全局状态 ==========
let loginState = {
  bizrt: null,
  accessToken: null,
  keyCode: null,
  userInfo: null
};

// ========== 凭证失效检测 (对应95598.js Oe和je函数) ==========

/**
 * 检测是否为凭证失效错误码 (对应95598.js Oe函数)
 */
const isCredentialExpired = (data) => {
  const code = Number(data?.code);
  const message = String(data?.message || '');

  // 凭证失效错误码集合
  const expiredCodes = new Set([10010, 30010, 10015, 10108, 10009, 10207, 10005, 20103]);
  if (expiredCodes.has(code)) return true;

  // 特殊错误组合
  if (code === 10004 && (message === '请求异常【GC117】' || message === '请求异常【010011】')) return true;
  if (code === 10002 && message === 'WEB渠道KeyCode已失效') return true;
  if (code === 10002 && message === 'Token 为空！') return true;

  return false;
};

/**
 * 检测message是否包含失效关键词 (对应95598.js je函数)
 */
const hasExpiredKeyword = (data) => {
  const message = String(data?.message || data || '');
  return /(无效|失效|过期|重新获取|请求异常|Token 为空|WEB渠道KeyCode已失效)/.test(message);
};

// ========== 自动重新登录 ==========

async function refreshToken(username, password) {
  console.log('\n🔄 检测到凭证失效，正在自动重新登录刷新凭证...');

  // 重新获取keyCode和登录
  const keyCode = await getKeyCode();
  const bizrt = await login(username, password, keyCode);
  const userInfo = bizrt.userInfo?.[0] || {};
  const authCode = await getAuthorizeCode(bizrt.token, keyCode);
  const accessToken = await getWebToken(authCode, bizrt.token, keyCode);

  // 更新全局状态
  loginState.bizrt = bizrt;
  loginState.accessToken = accessToken;
  loginState.keyCode = keyCode;
  loginState.userInfo = userInfo;

  console.log('✅ 凭证刷新成功');
  return { bizrt, accessToken, keyCode, userInfo };
}

// ========== 统一请求入口 ==========

const sgccRequest = async (config, retryCount = 0, username = null, password = null) => {
  console.log(`📡 请求: ${config.url}${retryCount > 0 ? ` (重试${retryCount})` : ''}`);

  // 1. 加密请求参数
  const encrypted = await encryptRequest(config);

  // 2. 发送到国网 - 使用加密返回的完整headers
  console.log('  → 发送国网...');
  console.log('  → URL:', encrypted.url);

  const sgccResponse = await fetchRequest(encrypted.url, {
    method: encrypted.method || 'post',
    headers: encrypted.headers || {},  // 直接使用加密返回的headers
    body: encrypted.body,
    timeout: 30
  });

  console.log('  → 国网响应:', sgccResponse.body.slice(0, 200));

  // 3. 检查HTTP错误
  if (!sgccResponse.ok) {
    throw new Error(sgccResponse.body || '请求失败');
  }

  // 4. 检查国网业务错误 - 登录态失效时自动刷新 (对应95598.js Oe/je函数)
  const sgccData = sgccResponse.data;
  if (isCredentialExpired(sgccData) || hasExpiredKeyword(sgccData)) {
    if (username && password && retryCount < 1) {
      // 自动重新登录
      console.log('  → 检测到凭证失效:', sgccData.code, sgccData.message);
      await refreshToken(username, password);
      // 使用新凭证重试请求
      const newConfig = { ...config };
      if (newConfig.headers) {
        newConfig.headers.token = loginState.bizrt.token;
        newConfig.headers.acctoken = loginState.accessToken;
        newConfig.headers.keyCode = loginState.keyCode.keyCode;
        newConfig.headers.publicKey = loginState.keyCode.publicKey;
      }
      return await sgccRequest(newConfig, retryCount + 1, username, password);
    }
    throw new Error(sgccData.message || '登录态失效');
  }

  // 5. 构建解密参数
  const decryptParams = {
    config: { ...config },
    data: sgccData
  };

  // keyCode请求需要保存encryptKey到config.headers
  if (config.url === '/api/oauth2/outer/c02/f02') {
    decryptParams.config.headers = { encryptKey: encrypted.encryptKey };
  }

  // 登录请求需要保存完整config.data
  if (config.data) {
    decryptParams.config.data = config.data;
  }

  // 6. 解密响应
  const result = await decryptResponse(decryptParams);

  // 7. 处理验证码重试 (RK1003)
  if (result.needRetry && retryCount < 3) {
    console.log('  → 添加验证码参数重试...');
    // 添加complexSlider参数
    const newConfig = { ...config };
    if (newConfig.data) {
      newConfig.data.complexSliderRet = 0;
      newConfig.data.complexSliderType = 'clickImg';
    }
    return await sgccRequest(newConfig, retryCount + 1, username, password);
  }

  return result;
};

// ========== API接口 ==========
const API = {
  keyCode: '/oauth2/outer/c02/f02',
  login: '/osg-web0004/open/c44/f06',
  authorize: '/oauth2/oauth/authorize',
  webToken: '/oauth2/outer/getWebToken',
  bindInfo: '/osg-open-uc0001/member/c9/f02',
  balance: '/osg-open-bc0001/member/c05/f01',
  usage: '/osg-web0004/member/c24/f01'
};

// ========== 业务函数 ==========

async function getKeyCode() {
  console.log('\n🔑 步骤1: 获取keyCode...');
  const result = await sgccRequest({
    url: `/api${API.keyCode}`,
    method: 'post',
    headers: {}
  });
  console.log('✅ keyCode获取成功');
  console.log('📦 keyCode:', result.keyCode);
  console.log('📦 publicKey:', result.publicKey);
  return result;
}

async function login(username, password, keyCode) {
  console.log('\n🔐 步骤2: 登录账号...');

  // 登录参数 (对应95598.js fn函数)
  const loginData = {
    params: {
      uscInfo: {
        devciceIp: '',
        tenant: 'state_grid',
        member: '0902',
        devciceId: ''
      },
      quInfo: {
        optSys: 'android',
        pushId: '000000',
        addressProvince: '110100',
        password: password,
        addressRegion: '110101',
        account: username,
        addressCity: '330100'
      }
    }
  };

  const result = await sgccRequest({
    url: `/api${API.login}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey
    },
    data: loginData
  });

  if (!result.bizrt?.userInfo) {
    throw new Error('登录失败: ' + JSON.stringify(result));
  }

  console.log('✅ 登录成功');
  return result.bizrt;
}

async function getAuthorizeCode(token, keyCode) {
  console.log('\n📋 步骤3: 获取授权码...');

  const result = await sgccRequest({
    url: `/api${API.authorize}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token
    }
  });

  // 提取授权码
  const redirectUrl = result.redirect_url || result.redirectUrl || result.data?.redirect_url || '';
  const match = redirectUrl.match(/[?&]code=([^&]+)/);
  const authCode = match ? decodeURIComponent(match[1]) : result.code || result.authorizeCode;

  console.log('✅ 授权码:', authCode);
  return authCode;
}

async function getWebToken(authCode, token, keyCode) {
  console.log('\n🎫 步骤4: 获取WebToken...');

  const result = await sgccRequest({
    url: `/api${API.webToken}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token,
      authorizecode: authCode
    }
  });

  if (!result.access_token) {
    throw new Error('获取Token失败: ' + JSON.stringify(result));
  }

  console.log('✅ Token获取成功');
  return result.access_token;
}

async function getBindInfo(token, accessToken, keyCode, userInfo, username = null, password = null) {
  console.log('\n🏠 步骤5: 获取绑定户号...');

  const userId = userInfo.userId || userInfo.accountId || userInfo.acctId;

  const result = await sgccRequest({
    url: `/api${API.bindInfo}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token,
      acctoken: accessToken
    },
    data: {
      serviceCode: '0101183',
      source: 'SGAPP',
      target: '32101',
      uscInfo: { member: '0902', devciceIp: '', devciceId: '', tenant: 'state_grid' },
      quInfo: { userId: userId },
      token: token,
      Channels: 'web'
    }
  }, 0, username, password);

  console.log('✅ 绑定信息获取成功');
  console.log('📦 绑定数据:', JSON.stringify(result, null, 2));
  return result.bizrt || result;
}

async function getBalance(consNoReal, consNoEnc, proCode, orgNo, consType, token, accessToken, keyCode, userInfo, username = null, password = null) {
  console.log('\n💰 步骤6: 获取余额...');

  const userId = userInfo.userId || userInfo.accountId || userInfo.acctId;
  const userName = userInfo.realName || userInfo.nickname || userInfo.loginAccount || userInfo.userName || '';

  const result = await sgccRequest({
    url: `/api${API.balance}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token,
      acctoken: accessToken
    },
    data: {
      data: {
        srvCode: '',
        serialNo: '',
        channelCode: '0902',
        funcCode: 'WEBA1007200',
        acctId: userId,
        userName: userName,
        promotType: '1',
        promotCode: '1',
        userAccountId: userId,
        list: [{
          consNoSrc: consNoReal,    // 真实户号 (consNo_dst)
          proCode: proCode,
          sceneType: consType || '',
          consNo: consNoEnc,        // 加密户号 (带99:前缀)
          orgNo: orgNo
        }]
      },
      serviceCode: '0101143',
      source: 'SGAPP',
      target: proCode
    }
  }, 0, username, password);

  return result.list?.[0] || result.data?.list?.[0] || result;
}

async function getDailyUsage(consNoReal, consNoEnc, proCode, orgNo, consType, token, accessToken, keyCode, userInfo, username = null, password = null) {
  console.log('\n⚡ 步骤7: 获取每日用电量...');

  const userId = userInfo.userId || userInfo.accountId || userInfo.acctId;
  const userName = userInfo.realName || userInfo.nickname || userInfo.loginAccount || userInfo.userName || '';
  const year = new Date().getFullYear();

  const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  // endTime = 昨天, startTime = 6天前 (对应95598.js Se函数: Se(1)和Se(6))
  const endTime = new Date();
  endTime.setDate(endTime.getDate() - 1);  // 昨天 (Se(1))
  const startTime = new Date();
  startTime.setDate(startTime.getDate() - 6);  // 6天前 (Se(6))

  // 用电量查询consNo用真实户号 (对应95598.js $n函数)
  const requestData = {
    url: `/api${API.usage}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token,
      acctoken: accessToken
    },
    data: {
      params1: {
        serviceCode: '0101183',
        source: 'SGAPP',
        target: '32101',
        uscInfo: { member: '0902', devciceIp: '', devciceId: '', tenant: 'state_grid' },
        quInfo: { userId: userId },
        token: token
      },
      params3: {
        data: {
          acctId: userId,
          consNo: consNoReal,
          consType: '02' === String(consType) ? '02' : '01',
          endTime: formatDate(endTime),
          orgNo: orgNo,
          queryYear: String(year),
          proCode: proCode,
          provinceCode: proCode,
          serialNo: '',
          srvCode: '',
          startTime: formatDate(startTime),
          userName: userName,
          funcCode: 'WEBALIPAY_01',
          channelCode: '0902',
          clearCache: '11',
          promotCode: '1',
          promotType: '1'
        },
        serviceCode: 'BCP_000026',
        source: 'app',
        target: proCode
      },
      params4: '010103'
    }
  };

  log.data('请求参数: ' + JSON.stringify(requestData.data));
  log.data('startTime: ' + formatDate(startTime) + ' endTime: ' + formatDate(endTime));
  log.data('consType: ' + consType + ' → ' + ('02' === String(consType) ? '02' : '01'));

  const result = await sgccRequest(requestData, 0, username, password);

  log.data('每日用电结果: ' + JSON.stringify(result));
  return result;
}

async function getMonthlyUsage(consNoReal, consNoEnc, proCode, orgNo, consType, token, accessToken, keyCode, userInfo, username = null, password = null) {
  console.log('\n📊 步骤8: 获取每月用电量...');

  const userId = userInfo.userId || userInfo.accountId || userInfo.acctId;
  const userName = userInfo.realName || userInfo.nickname || userInfo.loginAccount || userInfo.userName || '';
  const year = new Date().getFullYear();

  // 用电量查询consNo用真实户号 (对应95598.js $n函数)
  const result = await sgccRequest({
    url: `/api${API.usage}`,
    method: 'post',
    headers: {
      keyCode: keyCode.keyCode,
      publicKey: keyCode.publicKey,
      token: token,
      acctoken: accessToken
    },
    data: {
      params1: {
        serviceCode: '0101183',
        source: 'SGAPP',
        target: '32101',           // 95598.js params1.target 固定为 "32101"
        uscInfo: { member: '0902', devciceIp: '', devciceId: '', tenant: 'state_grid' },
        quInfo: { userId: userId },
        token: token
      },
      params3: {
        data: {
          acctId: userId,
          consNo: consNoReal,        // 真实户号 (用电量查询用真实户号!)
          consType: consType || '01',
          orgNo: orgNo,
          proCode: proCode,
          provinceCode: proCode,
          queryYear: String(year),
          serialNo: '',
          srvCode: '',
          userName: userName,
          funcCode: 'WEBALIPAY_01',
          channelCode: '0902',
          clearCache: '09',
          promotType: '1'
        },
        serviceCode: 'BCP_000026',
        source: 'app',
        target: proCode
      },
      params4: '010102'
    }
  }, 0, username, password);

  return result;
}

// ========== 主函数 ==========

async function main() {
  console.log('========================================');
  console.log('  网上国网电费查询');
  console.log('========================================\n');

  const username = process.env.SGCC_USERNAME || process.env.WSGW_USERNAME;
  const password = process.env.SGCC_PASSWORD || process.env.WSGW_PASSWORD;

  if (!username || !password) {
    console.error('❌ 请设置环境变量:');
    console.log('  $env:SGCC_USERNAME = "账号"');
    console.log('  $env:SGCC_PASSWORD = "密码"');
    process.exit(1);
  }

  console.log('📱 账号:', username.slice(0, 3) + '****' + username.slice(-4));

  try {
    // 获取风控上下文
    await getRiskContext();

    // 完整登录流程
    const keyCode = await getKeyCode();
    const bizrt = await login(username, password, keyCode);
    const userInfo = bizrt.userInfo?.[0] || {};
    const authCode = await getAuthorizeCode(bizrt.token, keyCode);
    const accessToken = await getWebToken(authCode, bizrt.token, keyCode);

    // 保存登录状态
    loginState.bizrt = bizrt;
    loginState.accessToken = accessToken;
    loginState.keyCode = keyCode;
    loginState.userInfo = userInfo;

    const bindInfo = await getBindInfo(bizrt.token, accessToken, keyCode, userInfo, username, password);

    // 获取户号列表 (户号在userInfo[0].powerUserList中)
    const userInfoData = bindInfo.userInfo?.[0] || bindInfo;
    const userList = userInfoData.powerUserList || bindInfo.userInfo || bindInfo.list || [];
    if (!userList.length) {
      throw new Error('未查询到绑定户号');
    }

    console.log('\n📋 查询到', userList.length, '个户号');

    // 查询每个户号 (consNoSrc用真实户号, consNo用加密户号)
    const results = [];
    for (const user of userList) {
      const consNoReal = user.consNo_dst || user.consNo;  // 真实户号 (用于consNoSrc)
      const consNoEnc = user.consNo || user.consNo_dst;   // 加密户号 (用于consNo)
      const proCode = user.proNo || user.provinceId || user.provinceCode || '32101';
      const orgNo = user.orgNo || user.orgNo_dst || '';
      const consType = user.constType || user.consType || user.consSortCode || '01';

      console.log('\n' + '='.repeat(40));
      console.log('  户号:', consNoReal);
      console.log('  户名:', user.consName_dst || user.consName || user.realName);
      console.log('  地址:', user.elecAddr_dst || user.elecAddr || user.address);
      console.log('='.repeat(40));

      // 使用最新的凭证查询
      const currentToken = loginState.bizrt.token;
      const currentAccessToken = loginState.accessToken;
      const currentKeyCode = loginState.keyCode;
      const currentUserInfo = loginState.userInfo;

      const balance = await getBalance(consNoReal, consNoEnc, proCode, orgNo, consType, currentToken, currentAccessToken, currentKeyCode, currentUserInfo, username, password);
      const daily = await getDailyUsage(consNoReal, consNoEnc, proCode, orgNo, consType, currentToken, currentAccessToken, currentKeyCode, currentUserInfo, username, password);
      const monthly = await getMonthlyUsage(consNoReal, consNoEnc, proCode, orgNo, consType, currentToken, currentAccessToken, currentKeyCode, currentUserInfo, username, password);

      results.push({
        consNo: consNoReal,
        consName: user.consName_dst || user.consName || user.realName,
        address: user.elecAddr_dst || user.elecAddr || user.address,
        orgName: user.orgName,
        proCode: proCode,
        balance: balance,
        dailyUsage: daily,
        monthlyUsage: monthly
      });
    }

    // 输出完整JSON
    console.log('\n\n');
    console.log('╔' + '═'.repeat(50) + '╗');
    console.log('║' + ' '.repeat(15) + '完整JSON查询结果' + ' '.repeat(15) + '║');
    console.log('╚' + '═'.repeat(50) + '╝');
    console.log('\n');
    console.log(JSON.stringify(results, null, 2));
    console.log('\n✅ 查询完成!');

    // 发送MQTT消息
    if (process.env.SGCC_MQTT_HOST) {
      await sendMqtt(results);
    }

  } catch (error) {
    console.error('\n❌ 错误:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// ========== MQTT发送函数 ==========

async function sendMqtt(results) {
  console.log('\n📡 发送MQTT消息...');

  const host = process.env.SGCC_MQTT_HOST;
  const port = process.env.SGCC_MQTT_PORT || '1883';
  const username = process.env.SGCC_MQTT_USER || '';
  const password = process.env.SGCC_MQTT_PASS || '';

  try {
    const mqtt = require('mqtt');
    const clientId = 'mqtt_sgcc_' + Date.now();

    const connectUrl = `mqtt://${host}:${port}`;
    const client = mqtt.connect(connectUrl, {
      clientId,
      clean: true,
      connectTimeout: 4000,
      username: username,
      password: password,
      reconnectPeriod: 1000
    });

    // 格式化日期函数
    const formatDate = (dateStr) => {
      const str = String(dateStr);
      const year = str.substring(0, 4);
      const month = str.substring(4, 6);
      const day = str.substring(6, 8);
      return year + '-' + month + (day ? '-' + day : '');
    };

    // 发送每个户号的数据
    client.on('connect', () => {
      console.log('  → MQTT连接成功');

      for (const result of results) {
        const topic = 'nodejs/state-grid/' + result.consNo;

        // 构建发送数据
        const data = {
          ...result.balance,
          consNo: result.consNo,
          consName: result.consName,
          address: result.address,
          orgName: result.orgName,
          proCode: result.proCode,
          // 每日用电列表
          dayList: (result.dailyUsage?.sevenEleList || []).filter(val => val.dayElePq !== '-').map(val => ({
            day: formatDate(val.day),
            dayElePq: val.dayElePq,
            thisVPq: val.thisVPq,
            thisPPq: val.thisPPq
          })),
          // 每月用电列表
          monthList: (result.monthlyUsage?.mothEleList || []).map(val => ({
            month: formatDate(val.month),
            monthEleNum: val.monthEleNum,
            monthEleCost: val.monthEleCost
          })),
          // 年度汇总
          totalEleNum: result.monthlyUsage?.dataInfo?.totalEleNum || 0,
          totalEleCost: result.monthlyUsage?.dataInfo?.totalEleCost || 0,
          // 五日总电量
          totalPq: result.dailyUsage?.totalPq || ''
        };

        client.publish(topic, JSON.stringify(data), { qos: 0, retain: true }, (error) => {
          if (error) {
            console.error('  → 发送失败:', error.message);
          } else {
            console.log('  → 已发送到主题:', topic);
          }
        });
      }
    });

    client.on('error', (error) => {
      console.error('  → MQTT连接错误:', error.message);
    });

    // 延迟关闭连接
    setTimeout(() => {
      client.end();
      console.log('  → MQTT连接已关闭');
    }, 3000);

    // 等待发送完成
    await new Promise(resolve => setTimeout(resolve, 3500));

  } catch (error) {
    console.error('  → MQTT发送失败:', error.message);
    console.log('  → 请确保已安装mqtt库: npm install mqtt');
  }
}

main();
