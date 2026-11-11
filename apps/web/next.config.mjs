const apiBaseUrl = (
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.API_BASE_URL ??
  'http://localhost:4000'
).replace(/\/$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiBaseUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
