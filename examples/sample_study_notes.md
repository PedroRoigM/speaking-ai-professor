# Sample Study Notes — Vehicle Dynamics & Classical Mechanics

> Drop any PDF, PPTX, XLSX, DOCX, or Markdown files into your own course folder and launch `professor` inside it. This sample file lets you try Speaking AI Professor right out of the box.

## 1. Longitudinal Load Transfer (Braking & Acceleration)

During longitudinal acceleration or braking $a_x$, inertial forces act through the vehicle's Center of Gravity (CG) at height $h_{CG}$ above the road plane, creating a pitching moment resisted by normal load changes on the front and rear axles separated by wheelbase $L$:

$$\Delta F_z = \frac{m \cdot a_x \cdot h_{CG}}{L}$$

- Under **braking**, the front axle gains load ($F_{z,f} = W_f + \Delta F_z$) and the rear axle loses load ($F_{z,r} = W_r - \Delta F_z$).
- Lowering $h_{CG}$ or lengthening the wheelbase $L$ reduces weight transfer and stabilizes the aero and tire platform.

## 2. Tire Vertical Load Sensitivity

Unlike rigid-body Coulomb friction ($\mu = \text{const}$), real pneumatic tires are viscoelastic: the effective coefficient of friction $\mu$ **decreases** as vertical load $F_z$ increases:

$$F_{y,\max}(F_z) = \mu(F_z) \cdot F_z, \qquad \frac{d\mu}{dF_z} < 0$$

Because $F_y(F_z)$ is concave, transferring $\Delta F_z$ from an inside tire to an outside tire during cornering always causes a **net loss of total lateral grip** on that axle.

## 3. Parallel Axis Theorem (Steiner's Theorem)

To compute a component's mass moment of inertia about a global vehicle axis parallel to its local centroidal axis separated by perpendicular distance $d_\perp$:

$$I_{\text{global}} = I_{\text{local}} + m \cdot d_\perp^2$$

Only coordinates **perpendicular** to the rotation axis unit vector $\hat{u}$ contribute to $d_\perp^2 = \|\Delta\vec{r} \times \hat{u}\|^2$.
