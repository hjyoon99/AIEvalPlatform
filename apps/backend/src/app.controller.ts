import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * 애플리케이션의 기본 응답을 반환한다.
   * @returns 상태 확인용 문자열
   */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
