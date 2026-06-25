export interface LoginBody {
  email: string;
  password: string;
}

export interface ForgotPasswordBody {
  email: string;
}

export interface ResetPasswordBody {
  token: string;
  email: string;
  newPassword: string;
}

export interface AuthTokenResponse {
  accessToken: string;
  expiresIn: number;
}
