import { defineBackend } from '@aws-amplify/backend';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { FunctionUrlAuthType, HttpMethod } from 'aws-cdk-lib/aws-lambda';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { bedrock } from './functions/bedrock/resource';

const backend = defineBackend({
  auth,
  data,
  bedrock,
});

const fn = backend.bedrock.resources.lambda;

// Bedrock の Claude モデル（クロスリージョン推論プロファイル含む）を呼べるようにする。
fn.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/anthropic.*',
      'arn:aws:bedrock:*:*:inference-profile/*',
    ],
  })
);

// AppSync の30秒上限を避けるため Function URL（IAM認証）で公開。最大300秒。
const fnUrl = fn.addFunctionUrl({
  authType: FunctionUrlAuthType.AWS_IAM,
  cors: {
    allowedOrigins: ['*'], // 本番では呼び出し元オリジンに絞ること
    allowedMethods: [HttpMethod.POST],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-amz-date',
      'x-amz-security-token',
      'x-amz-content-sha256',
    ],
  },
});

// サインイン済み(Cognito)ユーザーにのみ Function URL の呼び出しを許可。
fn.grantInvokeUrl(backend.auth.resources.authenticatedUserIamRole);

// フロントエンドが参照できるよう URL を出力（amplify_outputs.json の custom 配下）。
backend.addOutput({
  custom: {
    bedrockFunctionUrl: fnUrl.url,
  },
});
