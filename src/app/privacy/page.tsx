import Link from "next/link";

export const metadata = { title: "个人信息保护说明" };

export default function PrivacyPage() {
  return (
    <article className="card legal-document">
      <p className="eyebrow">研伴答疑 · 信息保护</p>
      <h1>个人信息保护说明</h1>
      <p className="caption">版本：2026-10-03</p>
      <section>
        <h2>我们保存的信息</h2>
        <p>注册时保存账号名、昵称、加密口令摘要、成年及条款确认记录。学生和教师的口令与资料分别存储在独立账号表中。学生可以补充学校和专业；教师需填写学校、学历、擅长科目、介绍及在校和非在职声明，用于审核和匹配。</p>
        <p>答疑业务保存问题、上传图片、邀请、双方进入与结束时间、消息和反馈。平台使用必要的登录Cookie维持登录状态，学生、教师及管理员的Cookie分别管理。</p>
      </section>
      <section>
        <h2>谁可以查看</h2>
        <p>个人账号资料和密码变更仅可由对应登录账号操作。对方可以看到交流所需的昵称、科目、问题及消息；题目图片仅可由上传学生、当前被邀请教师或答疑参与者访问。</p>
        <p>管理员可查看账号基础资料、审核教师和查看汇总统计。管理页面及CSV导出不提供私人聊天正文、题目图片或口令摘要。服务运维人员对数据库和附件的访问应限制在必要范围内。</p>
      </section>
      <section>
        <h2>设备权限与运行日志</h2>
        <p>摄像头和麦克风只在用户主动操作并获得浏览器授权后访问。结束答疑会停止本地媒体并退出音视频房间。平台不默认录音录像。</p>
        <p>为定位异常，服务保存有大小限制的运行日志，包括时间、错误类别、关联编号和进程退出原因。日志不保存口令、登录Cookie、音视频令牌、环境密钥或聊天正文。</p>
      </section>
      <section>
        <h2>维护与保护</h2>
        <p>可以在所属门户的个人资料页修改资料与密码。修改密码会撤销该账号的其他登录会话。请使用可信设备，离开公共设备前退出对应账号。</p>
        <p>数据库和题目附件由服务的实际部署管理员保存和备份。涉及资料更正、删除或访问权限的问题，应联系该服务的管理员处理。具体数据保留安排由实际运营方制定并告知用户。</p>
      </section>
      <div className="button-row">
        <Link className="button secondary" href="/terms">查看服务条款</Link>
        <Link className="button primary" href="/">返回首页</Link>
      </div>
    </article>
  );
}
