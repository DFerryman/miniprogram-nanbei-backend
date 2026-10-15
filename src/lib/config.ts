// 浏览器仅保留上传偏好；云开发配置由服务端环境变量提供。
export type UploadMode = 'proxy' | 'direct';

const UPLOAD_MODE_KEY = 'nanbei-admin.upload-mode';
let uploadMode: UploadMode = 'proxy';

/** 升级时清除旧版本曾保存在浏览器中的云开发凭据。 */
export function clearLegacyConfig() {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[name];
      storage.removeItem('nanbei-admin.profiles');
      storage.removeItem('nanbei-admin.active');
    } catch {
      // 浏览器禁用存储时仍可正常登录。
    }
  }
}

clearLegacyConfig();

export function getUploadMode(): UploadMode {
  try {
    const saved = localStorage.getItem(UPLOAD_MODE_KEY);
    if (saved === 'direct' || saved === 'proxy') uploadMode = saved;
  } catch {
    // 使用当前页面内的偏好。
  }
  return uploadMode;
}

export function saveUploadMode(value: UploadMode) {
  uploadMode = value;
  try {
    localStorage.setItem(UPLOAD_MODE_KEY, value);
  } catch {
    // 存储不可用时，偏好仅在当前页面有效。
  }
}
