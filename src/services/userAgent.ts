const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const MOBILE_CHROME_CLIENT_HINTS = {
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"'
};

/**
 * 判断当前请求头是否表示文档导航请求。
 * @param headers 调用方提供的请求头。
 * @returns 请求更接近浏览器文档导航时返回 true。
 */
function isDocumentRequest(headers: Record<string, string>): boolean {
    const accept = headers.Accept ?? headers.accept ?? '';
    return !headers['X-Requested-With']
        && !headers['x-requested-with']
        && (!accept || accept.includes('text/html'));
}

/**
 * 合并牛客移动端浏览器请求头与调用方提供的请求头。
 * @param headers 当前请求需要附加的请求头。
 * @returns 包含移动端 UA 和移动浏览器请求头的完整请求头。
 */
export function getNowcoderRequestHeaders(headers: Record<string, string>): Record<string, string> {
    const userAgentHeader = {
        'User-Agent': MOBILE_USER_AGENT
    };
    const fetchHeaders: Record<string, string> = isDocumentRequest(headers)
        ? {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        }
        : {
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };

    return {
        ...userAgentHeader,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...MOBILE_CHROME_CLIENT_HINTS,
        ...fetchHeaders,
        ...headers
    };
}
