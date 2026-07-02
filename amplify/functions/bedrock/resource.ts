import { defineFunction } from "@aws-amplify/backend";

/**
 * Claude on Amazon Bedrock を呼ぶ Lambda。
 * 認証情報は実行ロールから取得するため、ブラウザにキーは置かない。
 * AppSync(30秒上限)ではなく Function URL 経由で公開し、最大300秒まで実行できる。
 *
 * BEDROCK_REGION: Bedrock を呼ぶリージョン。Claude のモデルアクセスを
 * 有効化したリージョンを指定する（既定 ap-northeast-1 = 東京）。
 */
export const bedrock = defineFunction({
  name: "bedrock",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  memoryMB: 512,
  environment: {
    BEDROCK_REGION: "ap-northeast-1",
  },
});
