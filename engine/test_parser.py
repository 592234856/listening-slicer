# -*- coding: utf-8 -*-
"""parser 冒烟测试：模拟混杂试卷文本。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parser import parse_paper_text

SAMPLE = """
第一节 听下面5段对话。每段对话后有一个小题，从题中所给的A、B、C三个选项中选出最佳选项。

Text 1
M: Excuse me, can you tell me how much the shirt is?
W: Yes, it's nine fifteen.

1. How much is the shirt?
A. £19.15.  B. £9.18.  C. £9.15.

Text 2
W: Hi, Tom. Are you going to the school concert tonight?
M: I'd love to, but I have to finish my history report.

2. What will Tom do tonight?
A. Go to the concert.  B. Finish a report.  C. Visit a friend.

第二节 听下面几段材料。

Text 3
W: Good morning, sir. What can I do for you?
M: I'd like to buy a ticket to London. Is there a direct train?
W: Yes, there is one at nine thirty.
"""

def main():
    mats = parse_paper_text(SAMPLE)
    assert len(mats) == 3, f"期望 3 段材料, 实际 {len(mats)}: {[m.title for m in mats]}"
    assert mats[0].title.lower().startswith("text 1"), mats[0].title
    assert "nine fifteen" in mats[0].text
    assert "How much is the shirt" not in mats[0].text  # 题号行已剔除
    assert "£19.15" not in mats[0].text  # 选项行已剔除
    assert not any("回答" in m.text or "选出" in m.text for m in mats)
    for m in mats:
        assert len(m.sentences) >= 2, (m.title, m.sentences)
    print("parser 冒烟测试通过：")
    for m in mats:
        print(f"  {m.title}: {len(m.sentences)} 句 | {m.text[:60]}...")

if __name__ == "__main__":
    main()
