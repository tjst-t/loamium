# 数式 (KaTeX)

`$...$` でインライン数式、`$$...$$` でブロック数式が描画されます(KaTeX)。

## インライン数式

三平方の定理は $a^2 + b^2 = c^2$ で、黄金比は $\phi = \frac{1 + \sqrt{5}}{2}$ です。

## ブロック数式

$$
f(x) = \int_{-\infty}^{\infty} \hat{f}(\xi)\, e^{2 \pi i \xi x} \, d\xi
$$

$$
\begin{aligned}
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \cdot \mathbf{B} &= 0
\end{aligned}
$$

## ポイント

- カーソルを数式の行に置くと TeX ソースに戻り、外すと再描画されます
- 記法は素の `$` / `$$` のまま保存されます(独自記法なし)
