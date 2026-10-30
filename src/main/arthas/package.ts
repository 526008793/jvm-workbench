import { ARTHAS_VERSION } from '../../shared/arthas';
import { shellQuote } from '../../shared/commands';

// The unclassified Maven JAR is not executable; use the official self-contained launcher.
export const ARTHAS_BOOT_URL = `https://repo.maven.apache.org/maven2/com/taobao/arthas/arthas-boot/${ARTHAS_VERSION}/arthas-boot-${ARTHAS_VERSION}-jar-with-dependencies.jar`;
export const ARTHAS_BOOT_SHA256 =
  '5a967356d04db1bf34237dfe5419b67fcea80d4bc47c6b70c466883561d4ac85';

const completenessCheck =
  'complete=1; for file in arthas-boot.jar arthas-core.jar arthas-agent.jar arthas-spy.jar arthas-client.jar; do test -s "$home/$file" || complete=0; done; test -d "$home/lib" || complete=0;';

export function packageProbe(home: string): string {
  return `home=${shellQuote(home)}; ${completenessCheck} if [ "$complete" = 1 ]; then printf present; elif test -s "$home/arthas-boot.jar"; then printf boot; else printf missing; fi`;
}

export function packageInstall(home: string, java: string): string {
  // Only install the launcher. Its Java ZIP implementation downloads/extracts dependencies on use.
  return [
    'set -e;',
    `home=${shellQuote(home)};`,
    'for tool in curl sha256sum mktemp mkdir cp rm; do command -v "$tool" >/dev/null 2>&1 || { printf "缺少工具 %s，无法下载Arthas启动JAR；也可手动放置arthas-boot.jar后重试\\n" "$tool" >&2; exit 1; }; done;',
    'mkdir -p "$home" || { printf "Arthas目录不可写，请选择JVM用户可写的目录\\n" >&2; exit 1; };',
    'test -w "$home" || { printf "Arthas目录不可写，请选择JVM用户可写的目录\\n" >&2; exit 1; };',
    'stage=$(mktemp -d /tmp/tracelogdock-arthas.XXXXXX);',
    `trap 'rm -rf "$stage"' EXIT; trap 'exit 130' HUP INT TERM;`,
    `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$stage/arthas-boot.jar" ${shellQuote(ARTHAS_BOOT_URL)} || { printf "Arthas启动JAR下载失败，请检查容器HTTPS出网后重试\\n" >&2; exit 1; };`,
    `printf '%s  %s\\n' ${shellQuote(ARTHAS_BOOT_SHA256)} "$stage/arthas-boot.jar" | sha256sum -c - || { printf "Arthas启动JAR的SHA-256校验失败，未安装，请重试\\n" >&2; exit 1; };`,
    `help=$(ARTHAS_LIB_DIR="$stage/cache/.arthas/lib" ${shellQuote(java)} -Duser.home="$stage/cache" -jar "$stage/arthas-boot.jar" --help 2>&1) || { printf 'Arthas启动检查失败：%s\\n' "$help" >&2; exit 1; };`,
    `case "$help" in *'arthas-boot version: ${ARTHAS_VERSION}'*) ;; *) printf "Arthas启动JAR版本不匹配，未安装\\n" >&2; exit 1;; esac;`,
    'cp "$stage/arthas-boot.jar" "$home/arthas-boot.jar" || { printf "Arthas启动JAR安装失败，请检查目录写权限和磁盘空间后重试\\n" >&2; exit 1; };',
  ].join(' ');
}
