import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

/** Phone (OTP) login appears only where an SMS gateway is set up: LOGIN_PHONE=1 on the web container. */
export default function LoginPage() {
  return <Suspense><LoginForm phoneEnabled={process.env.LOGIN_PHONE === '1'} /></Suspense>;
}
