import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    if (request.path !== '/api' && !request.path.startsWith('/api/')) {
      response.status(500).end();
      return;
    }

    let status = 500;
    let message = '서버에서 오류가 발생했습니다.';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const detail = exception.getResponse();
      if (typeof detail === 'string') {
        message = detail;
      } else if (typeof detail === 'object' && detail !== null) {
        const body = detail as { error?: unknown; message?: unknown; userMessage?: unknown };
        const text = typeof body.userMessage === 'string'
          ? body.userMessage
          : typeof body.message === 'string' || Array.isArray(body.message)
            ? body.message
            : body.error;
        if (typeof text === 'string') message = text;
        else if (Array.isArray(text)) message = text.join(' ');
      }
    }

    response.status(status).json({ error: message });
  }
}