import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { healthRouter } from './routes/health.js';
import { mandatesRouter } from './routes/mandates.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.use('/health', healthRouter);
  app.use('/mandates', mandatesRouter);

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      console.error(error);
      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
