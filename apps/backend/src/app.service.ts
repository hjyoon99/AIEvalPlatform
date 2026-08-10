import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  /**
   * 루트 엔드포인트에서 사용할 상태 확인용 문구를 만든다.
   * @returns 기본 인사 문자열
   */
  getHello(): string {
    return 'Hello World!';
  }
}
