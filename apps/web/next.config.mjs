const apiBaseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

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
